import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  extractJsonMiddleware,
  generateText,
  Output,
  smoothStream,
  streamText,
  wrapLanguageModel,
} from 'ai';

import type { ModelRole, OpenhomieConfig } from '../config/types.js';
import { type FetchLike, probeOllama } from '../llm/ollama.js';
import { getAnthropicThinking } from '../llm/thinking.js';
import { createEmbedder, type Embedder } from '../memory/embeddings.js';
import { errorFields, log } from '../util/logger.js';
import {
  ensureMppClient,
  isAbortLikeError,
  isProbablyOllama,
  isProbablyOpenAi,
  isProbablyOpenRouter,
  type ResolvedModel,
  requireEnv,
} from './ai-sdk-providers.js';
import { collectStreamTextAndEvents } from './ai-sdk-streaming.js';
import { toolDefsToAiTools } from './ai-sdk-tools.js';
import { normalizeUsage } from './ai-sdk-usage.js';
import type {
  CompleteObjectParams,
  CompleteParams,
  CompletionObjectResult,
  CompletionResult,
  LLMBackend,
} from './types.js';

export interface CreateAiSdkBackendOptions {
  config: OpenhomieConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  streamTextImpl?: typeof streamText;
  generateTextImpl?: typeof generateText;
}

export class AiSdkBackend implements LLMBackend {
  private readonly logger = log.child({ component: 'ai_sdk_backend' });
  private readonly stream: typeof streamText;
  private readonly generate: typeof generateText;
  private readonly defaultModel: ResolvedModel;
  private readonly fastModel: ResolvedModel;
  private readonly telemetryEnabled: boolean;
  public readonly embedder: Embedder | undefined;

  private circuit = {
    failures: 0,
    openUntilMs: 0,
  };

  private constructor(opts: {
    stream: typeof streamText;
    generate: typeof generateText;
    defaultModel: ResolvedModel;
    fastModel: ResolvedModel;
    telemetryEnabled: boolean;
    embedder?: Embedder | undefined;
  }) {
    this.stream = opts.stream;
    this.generate = opts.generate;
    this.defaultModel = opts.defaultModel;
    this.fastModel = opts.fastModel;
    this.telemetryEnabled = opts.telemetryEnabled;
    this.embedder = opts.embedder;
  }

  public static async create(options: CreateAiSdkBackendOptions): Promise<AiSdkBackend> {
    interface ProviderEnv extends NodeJS.ProcessEnv {
      ANTHROPIC_API_KEY?: string;
      OPENAI_BASE_URL?: string;
      OPENROUTER_API_KEY?: string;
      OPENAI_API_KEY?: string;
      MPP_PRIVATE_KEY?: string;
      MPP_RPC_URL?: string;
      HOMIE_AI_TELEMETRY?: string;
    }

    const env = (options.env ?? process.env) as ProviderEnv;
    const fetchImpl = options.fetchImpl ?? fetch;
    const streamImpl = options.streamTextImpl ?? streamText;
    const generateImpl = options.generateTextImpl ?? generateText;
    const telemetryEnabled = ['1', 'true', 'yes', 'on'].includes(
      (env.HOMIE_AI_TELEMETRY ?? '').trim().toLowerCase(),
    );
    const logger = log.child({ component: 'ai_sdk_backend' });

    const cfg = options.config;
    const ids = cfg.model.models;

    const withMiddleware = (resolved: ResolvedModel): ResolvedModel => {
      if (typeof resolved.model === 'string') return resolved;
      return {
        ...resolved,
        model: wrapLanguageModel({
          // AI SDK typings are versioned; runtime model objects satisfy the wrapper contract.
          // biome-ignore lint/suspicious/noExplicitAny: bridge SDK versioned types
          model: resolved.model as any,
          // biome-ignore lint/suspicious/noExplicitAny: bridge SDK versioned types
          middleware: [extractJsonMiddleware()] as any,
        }) as unknown as ResolvedModel['model'],
      };
    };

    if (cfg.model.provider.kind === 'claude-code' || cfg.model.provider.kind === 'codex-cli') {
      throw new Error(
        `Provider "${cfg.model.provider.kind}" requires the CLI backend factory. Use createBackend().`,
      );
    }

    if (cfg.model.provider.kind === 'mpp') {
      await ensureMppClient(env);
      const rootBaseUrl = cfg.model.provider.baseUrl ?? 'https://mpp.tempo.xyz';
      const normalizedRoot = rootBaseUrl.replace(/\/+$/u, '');
      const hasExplicitSuffix =
        normalizedRoot.endsWith('/openai/v1') || normalizedRoot.endsWith('/openrouter/v1');
      // Default to the OpenAI-compatible endpoint because it is fully specified and priced
      // in the MPP proxy service definitions, while OpenRouter support can vary.
      const mppBaseUrl = hasExplicitSuffix ? normalizedRoot : `${normalizedRoot}/openai/v1`;
      const mppEndpoint = mppBaseUrl.endsWith('/openrouter/v1')
        ? 'openrouter'
        : mppBaseUrl.endsWith('/openai/v1')
          ? 'openai'
          : 'unknown';
      const providerInstance = createOpenAICompatible({
        name: `mpp-${mppEndpoint}`,
        baseURL: mppBaseUrl,
      });
      const normalizeMppModelId = (rawId: string): string => {
        // OpenRouter model ids are typically provider-prefixed (e.g. "openai/gpt-4o-mini").
        // The OpenAI-compatible endpoints expect the plain model name (e.g. "gpt-4o-mini").
        if (mppEndpoint === 'openai' && rawId.includes('/')) return rawId.split('/').pop() ?? rawId;
        return rawId;
      };
      const make = (role: ModelRole): ResolvedModel => {
        const rawId = ids[role];
        const id = normalizeMppModelId(rawId);
        return withMiddleware({ role, id: rawId, model: providerInstance.chatModel(id) });
      };
      return new AiSdkBackend({
        stream: streamImpl,
        generate: generateImpl,
        defaultModel: make('default'),
        fastModel: make('fast'),
        telemetryEnabled,
      });
    }

    if (cfg.model.provider.kind === 'anthropic') {
      requireEnv(env, 'ANTHROPIC_API_KEY', 'Set it in your environment or .env file.');

      const make = (role: ModelRole): ResolvedModel => {
        const id = ids[role];
        const thinking = getAnthropicThinking(id, role);
        const base: ResolvedModel = { role, id, model: anthropic(id) };
        if (!thinking) return base;
        return { ...base, providerOptions: { anthropic: { thinking } } };
      };

      let embedder: Embedder | undefined;
      try {
        if (env.OPENAI_API_KEY) {
          const openaiProvider = createOpenAICompatible({
            name: 'openai-embeddings',
            baseURL: 'https://api.openai.com/v1',
            apiKey: env.OPENAI_API_KEY,
          });
          embedder = createEmbedder(
            openaiProvider.textEmbeddingModel('text-embedding-3-small'),
            1536,
          );
        }
      } catch (err) {
        // Embeddings unavailable — vector search disabled
        logger.debug('embedder.unavailable', errorFields(err));
      }

      return new AiSdkBackend({
        stream: streamImpl,
        generate: generateImpl,
        defaultModel: withMiddleware(make('default')),
        fastModel: withMiddleware(make('fast')),
        telemetryEnabled,
        embedder,
      });
    }

    const baseURL = cfg.model.provider.baseUrl ?? env.OPENAI_BASE_URL;
    if (!baseURL) {
      throw new Error(
        'OpenAI-compatible provider requires baseUrl (set model.base_url or OPENAI_BASE_URL).',
      );
    }

    let apiKey: string | undefined;
    if (isProbablyOllama(baseURL)) {
      await probeOllama(baseURL, fetchImpl);
    } else if (isProbablyOpenRouter(baseURL)) {
      apiKey = requireEnv(env, 'OPENROUTER_API_KEY', 'OpenRouter requires OPENROUTER_API_KEY.');
    } else if (isProbablyOpenAi(baseURL)) {
      apiKey = requireEnv(env, 'OPENAI_API_KEY', 'OpenAI requires OPENAI_API_KEY.');
    } else {
      apiKey = env.OPENAI_API_KEY?.trim() || undefined;
    }

    const providerInstance = createOpenAICompatible({
      name: 'openai-compatible',
      baseURL,
      ...(apiKey ? { apiKey } : {}),
    });

    const make = (role: ModelRole): ResolvedModel => {
      const id = ids[role];
      return withMiddleware({ role, id, model: providerInstance.chatModel(id) });
    };

    let embedder: Embedder | undefined;
    try {
      if (isProbablyOllama(baseURL)) {
        embedder = createEmbedder(providerInstance.textEmbeddingModel('nomic-embed-text'), 768);
      } else {
        embedder = createEmbedder(
          providerInstance.textEmbeddingModel('text-embedding-3-small'),
          1536,
        );
      }
    } catch (err) {
      // Embeddings unavailable
      logger.debug('embedder.unavailable', errorFields(err));
    }

    return new AiSdkBackend({
      stream: streamImpl,
      generate: generateImpl,
      defaultModel: make('default'),
      fastModel: make('fast'),
      telemetryEnabled,
      embedder,
    });
  }

  private telemetrySettings(
    functionId: string,
    metadata: Record<string, string | number | boolean>,
  ):
    | {
        isEnabled: boolean;
        functionId: string;
        metadata: Record<string, string | number | boolean>;
        recordInputs: boolean;
        recordOutputs: boolean;
      }
    | undefined {
    if (!this.telemetryEnabled) return undefined;
    return {
      isEnabled: true,
      functionId,
      metadata,
      recordInputs: false,
      recordOutputs: false,
    };
  }

  public async complete(params: CompleteParams): Promise<CompletionResult> {
    const nowMs = Date.now();
    const circuitOpen = this.circuit.openUntilMs > nowMs;
    // If the primary model is failing repeatedly, fall back to the fast model temporarily.
    const roleModel =
      params.role === 'fast' ? this.fastModel : circuitOpen ? this.fastModel : this.defaultModel;
    if (params.role !== 'fast' && circuitOpen) {
      this.logger.warn('circuit.fallback_to_fast', {
        openUntilMs: this.circuit.openUntilMs,
        defaultModel: this.defaultModel.id,
        fastModel: this.fastModel.id,
      });
    }

    const maxSteps = params.maxSteps;
    const tools = toolDefsToAiTools(params.tools, params.signal, params.toolContext);
    type StreamTextArgs = Parameters<typeof streamText>[0];
    type ProviderOptions = StreamTextArgs extends { providerOptions?: infer P } ? P : never;

    try {
      const telemetry = this.telemetrySettings('homie.complete', {
        role: params.role,
        model: roleModel.id,
        hasTools: Object.keys(tools).length > 0,
      });
      const repairToolCall = async ({
        toolCall,
      }: {
        toolCall?: { input?: unknown; [key: string]: unknown };
      }): Promise<unknown> => {
        const input = toolCall?.input;
        if (typeof input !== 'string') return null;
        const trimmed = input.trim();
        if (!trimmed) return null;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          return {
            ...toolCall,
            input: parsed,
          };
        } catch (err) {
          log.debug('parseToolInput.json_parse_failed', errorFields(err));
          return null;
        }
      };
      const streamArgs = {
        model: roleModel.model,
        providerOptions: roleModel.providerOptions as ProviderOptions,
        stopWhen: ({ steps }) => steps.length >= maxSteps,
        maxRetries: params.signal ? 0 : 3,
        timeout: { totalMs: 120_000, chunkMs: 15_000 },
        experimental_transform: smoothStream(),
        ...(telemetry ? { experimental_telemetry: telemetry } : {}),
        onError: ({ error }: { error: unknown }) => {
          params.stream?.onError?.(error);
          this.logger.debug('complete.stream_error', errorFields(error));
        },
        onAbort: () => {
          params.stream?.onAbort?.();
        },
        onStepFinish: (step: {
          finishReason?: string | undefined;
          usage?: unknown;
          steps?: unknown[];
        }) => {
          const usage = normalizeUsage(step.usage);
          const stepsCount = Array.isArray(step.steps) ? step.steps.length : 1;
          params.stream?.onStepFinish?.({
            index: Math.max(0, stepsCount - 1),
            ...(step.finishReason ? { finishReason: String(step.finishReason) } : {}),
            ...(usage ? { usage } : {}),
          });
        },
        ...(Object.keys(tools).length ? { tools } : {}),
        ...(Object.keys(tools).length
          ? {
              experimental_repairToolCall:
                repairToolCall as StreamTextArgs['experimental_repairToolCall'],
            }
          : {}),
        messages: params.messages,
        ...(params.signal ? { abortSignal: params.signal } : {}),
      } as StreamTextArgs;
      const result = this.stream(streamArgs);

      const streamObserver = params.stream;
      let text = '';
      if (streamObserver) {
        text = await collectStreamTextAndEvents(result, streamObserver);
        streamObserver.onFinish?.();
      } else {
        // AI SDK: `text` is a Promise<string>, `steps` is a Promise<...>, usage is best-effort.
        text = (await result.text).trim();
      }
      const usagePromise = (result as unknown as { totalUsage?: Promise<unknown> }).totalUsage;
      const usageRaw = usagePromise ? await usagePromise.catch(() => undefined) : undefined;
      const usage = normalizeUsage(usageRaw);

      // Reset circuit breaker on success.
      this.circuit.failures = 0;
      this.circuit.openUntilMs = 0;

      // Keep our harness-level step log minimal for now.
      const steps = [{ type: 'llm' as const, text }];
      return {
        text,
        steps,
        modelId: roleModel.id,
        ...(usage ? { usage } : {}),
      };
    } catch (err) {
      if (isAbortLikeError(err)) {
        this.logger.debug('complete.aborted', {
          role: params.role,
          model: roleModel.id,
        });
        throw err;
      }
      // Simple circuit breaker: after repeated failures, temporarily fall back to fast model.
      this.circuit.failures += 1;
      this.logger.error('complete.failed', {
        role: params.role,
        model: roleModel.id,
        failures: this.circuit.failures,
        ...errorFields(err),
      });
      if (this.circuit.failures >= 5) {
        this.circuit.openUntilMs = Date.now() + 60_000;
        this.logger.warn('circuit.open', { openUntilMs: this.circuit.openUntilMs });
      }
      throw err;
    }
  }

  public async completeObject<T>(
    params: CompleteObjectParams<T>,
  ): Promise<CompletionObjectResult<T>> {
    const nowMs = Date.now();
    const circuitOpen = this.circuit.openUntilMs > nowMs;
    const roleModel =
      params.role === 'fast' ? this.fastModel : circuitOpen ? this.fastModel : this.defaultModel;
    if (params.role !== 'fast' && circuitOpen) {
      this.logger.warn('circuit.fallback_to_fast', {
        openUntilMs: this.circuit.openUntilMs,
        defaultModel: this.defaultModel.id,
        fastModel: this.fastModel.id,
      });
    }

    type GenerateTextArgs = Parameters<typeof generateText>[0];
    type ProviderOptions = GenerateTextArgs extends { providerOptions?: infer P } ? P : never;

    try {
      const telemetry = this.telemetrySettings('homie.complete_object', {
        role: params.role,
        model: roleModel.id,
      });
      const result = await this.generate({
        model: roleModel.model,
        providerOptions: roleModel.providerOptions as ProviderOptions,
        output: Output.object({ schema: params.schema as never }),
        maxRetries: params.signal ? 0 : 3,
        timeout: { totalMs: 120_000, chunkMs: 15_000 },
        ...(params.signal ? { abortSignal: params.signal } : {}),
        ...(telemetry ? { experimental_telemetry: telemetry } : {}),
        messages: params.messages,
      });
      const usageRaw = {
        ...result.totalUsage,
        providerMetadata: result.providerMetadata,
      } as unknown;
      const usage = normalizeUsage(usageRaw);

      this.circuit.failures = 0;
      this.circuit.openUntilMs = 0;

      return {
        output: result.output as T,
        modelId: roleModel.id,
        ...(usage ? { usage } : {}),
      };
    } catch (err) {
      if (isAbortLikeError(err)) {
        this.logger.debug('complete_object.aborted', {
          role: params.role,
          model: roleModel.id,
        });
        throw err;
      }
      this.circuit.failures += 1;
      this.logger.error('complete_object.failed', {
        role: params.role,
        model: roleModel.id,
        failures: this.circuit.failures,
        ...errorFields(err),
      });
      if (this.circuit.failures >= 5) {
        this.circuit.openUntilMs = Date.now() + 60_000;
        this.logger.warn('circuit.open', { openUntilMs: this.circuit.openUntilMs });
      }
      throw err;
    }
  }
}
