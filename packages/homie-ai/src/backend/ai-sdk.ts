import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type Tool as AiTool, type LanguageModel, streamText, tool } from 'ai';

import type { HomieConfig, ModelRole } from '../config/types.js';
import { type FetchLike, probeOllama } from '../llm/ollama.js';
import { getAnthropicThinking } from '../llm/thinking.js';
import { createEmbedder, type Embedder } from '../memory/embeddings.js';
import type { ToolContext, ToolDef } from '../tools/types.js';
import { errorFields, log } from '../util/logger.js';
import type {
  CompleteParams,
  CompletionResult,
  CompletionStreamObserver,
  LLMBackend,
} from './types.js';

interface ResolvedModel {
  role: ModelRole;
  id: string;
  model: LanguageModel;
  providerOptions?: Record<string, unknown> | undefined;
}

const isProbablyOllama = (baseUrl: string): boolean => {
  const u = baseUrl.toLowerCase();
  return u.includes('localhost:11434') || u.includes('127.0.0.1:11434');
};

const isProbablyOpenRouter = (baseUrl: string): boolean => {
  return baseUrl.toLowerCase().includes('openrouter.ai');
};

const isProbablyOpenAi = (baseUrl: string): boolean => {
  return baseUrl.toLowerCase().includes('api.openai.com');
};

const requireEnv = (env: NodeJS.ProcessEnv, key: string, hint: string): string => {
  const value = env[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing ${key}. ${hint}`);
};

const mppInitCache = new Map<string, Promise<void>>();

const MPP_DEFAULT_MAX_DEPOSIT = '10';

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

interface UsageRecord extends Record<string, unknown> {
  cost?: unknown;
  totalCost?: unknown;
  costUsd?: unknown;
  usage?: unknown;
  providerMetadata?: unknown;
}

const asRecord = (value: unknown): UsageRecord | null => {
  if (!value || typeof value !== 'object') return null;
  return value as UsageRecord;
};

const extractUsageCostUsd = (usageRaw: unknown): number | undefined => {
  const root = asRecord(usageRaw);
  if (!root) return undefined;

  const candidates: unknown[] = [root.cost, root.totalCost, root.costUsd];
  const usage = asRecord(root.usage);
  if (usage) {
    candidates.push(usage.cost, usage.totalCost, usage.costUsd);
  }

  const providerMetadata = asRecord(root.providerMetadata);
  if (providerMetadata) {
    for (const value of Object.values(providerMetadata)) {
      const providerSlice = asRecord(value);
      if (!providerSlice) continue;
      candidates.push(providerSlice.cost, providerSlice.totalCost, providerSlice.costUsd);
    }
  }

  for (const candidate of candidates) {
    const cost = asFiniteNumber(candidate);
    if (cost !== undefined && cost >= 0) return cost;
  }
  return undefined;
};

const TX_HASH_PATTERN = /\b0x[a-fA-F0-9]{64}\b/u;

const txHashFromString = (value: string): string | undefined => {
  const direct = value.match(TX_HASH_PATTERN)?.[0];
  if (direct) return direct.toLowerCase();

  // Some providers nest payment proof data in base64 payloads.
  if (/^[A-Za-z0-9+/=]{40,}$/u.test(value)) {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const nested = decoded.match(TX_HASH_PATTERN)?.[0];
      if (nested) return nested.toLowerCase();
    } catch {
      // Best-effort decode only.
    }
  }
  return undefined;
};

const extractUsageTxHash = (usageRaw: unknown): string | undefined => {
  const scan = (value: unknown, depth: number): string | undefined => {
    if (depth > 5) return undefined;
    if (typeof value === 'string') return txHashFromString(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = scan(item, depth + 1);
        if (nested) return nested;
      }
      return undefined;
    }
    const rec = asRecord(value);
    if (!rec) return undefined;

    for (const key of ['txHash', 'transactionHash', 'paymentTxHash', 'hash'] as const) {
      const nested = scan(rec[key], depth + 1);
      if (nested) return nested;
    }

    for (const [key, nestedValue] of Object.entries(rec)) {
      if (/hash|tx/iu.test(key)) {
        const nested = scan(nestedValue, depth + 1);
        if (nested) return nested;
      }
    }
    for (const nestedValue of Object.values(rec)) {
      const nested = scan(nestedValue, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  };

  const fromTree = scan(usageRaw, 0);
  if (fromTree) return fromTree;
  try {
    const serialized = JSON.stringify(usageRaw);
    if (!serialized) return undefined;
    return txHashFromString(serialized);
  } catch {
    return undefined;
  }
};

const ensureMppClient = async (
  env: NodeJS.ProcessEnv & {
    MPP_PRIVATE_KEY?: string | undefined;
    MPP_MAX_DEPOSIT?: string | undefined;
  },
): Promise<void> => {
  const privateKey = requireEnv(
    env,
    'MPP_PRIVATE_KEY',
    'MPP provider requires a funded wallet private key.',
  );
  if (!privateKey.startsWith('0x')) {
    throw new Error('Invalid MPP_PRIVATE_KEY: expected 0x-prefixed hex string');
  }
  const cacheKey = privateKey;
  const cached = mppInitCache.get(cacheKey);
  if (cached) return cached;
  const maxDeposit = env.MPP_MAX_DEPOSIT?.trim() || MPP_DEFAULT_MAX_DEPOSIT;
  const promise = Promise.all([import('mppx/client'), import('viem/accounts')])
    .then(([mppxClient, viemAccounts]) => {
      const account = viemAccounts.privateKeyToAccount(privateKey as `0x${string}`);
      mppxClient.Mppx.create({
        methods: [mppxClient.tempo({ account, maxDeposit })],
      });
    })
    .catch((err) => {
      mppInitCache.delete(cacheKey);
      if (err instanceof Error && /cannot find module|cannot find package/iu.test(err.message)) {
        throw new Error('MPP provider requires the mppx and viem packages. Run: bun add mppx viem');
      }
      throw err;
    });
  mppInitCache.set(cacheKey, promise);
  return promise;
};

const wrapToolOutputText = (toolName: string, text: string): string => {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<external') || trimmed.startsWith('<tool_output')) return text;
  const safeName = toolName.replace(/[^a-z0-9:_-]/giu, '_');
  const safeText = text.replaceAll('</tool_output>', '</tool_output_>');
  return `<tool_output name="${safeName}">\n${safeText}\n</tool_output>`;
};

const toolDefsToAiTools = (
  defs: readonly ToolDef[] | undefined,
  rootSignal: AbortSignal | undefined,
  toolContext: Omit<ToolContext, 'now' | 'signal'> | undefined,
): Record<string, AiTool> => {
  const out: Record<string, AiTool> = {};
  if (!defs) return out;

  for (const def of defs) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input) => {
        const timeoutMs = def.timeoutMs ?? 60_000;
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );

        const onAbort = (): void => {
          if (controller.signal.aborted) return;
          const reason = rootSignal?.reason;
          controller.abort(reason ?? new Error('Aborted'));
        };
        if (rootSignal) {
          if (rootSignal.aborted) onAbort();
          else rootSignal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          const result = await def.execute(input, {
            ...(toolContext ?? {}),
            now: new Date(),
            signal: controller.signal,
          });
          return typeof result === 'string' ? wrapToolOutputText(def.name, result) : result;
        } finally {
          clearTimeout(timer);
          if (rootSignal) rootSignal.removeEventListener('abort', onAbort);
        }
      },
    });
  }
  return out;
};

export interface CreateAiSdkBackendOptions {
  config: HomieConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  streamTextImpl?: typeof streamText;
}

export class AiSdkBackend implements LLMBackend {
  private readonly logger = log.child({ component: 'ai_sdk_backend' });
  private readonly stream: typeof streamText;
  private readonly defaultModel: ResolvedModel;
  private readonly fastModel: ResolvedModel;
  public readonly embedder: Embedder | undefined;

  private circuit = {
    failures: 0,
    openUntilMs: 0,
  };

  private constructor(opts: {
    stream: typeof streamText;
    defaultModel: ResolvedModel;
    fastModel: ResolvedModel;
    embedder?: Embedder | undefined;
  }) {
    this.stream = opts.stream;
    this.defaultModel = opts.defaultModel;
    this.fastModel = opts.fastModel;
    this.embedder = opts.embedder;
  }

  public static async create(options: CreateAiSdkBackendOptions): Promise<AiSdkBackend> {
    interface ProviderEnv extends NodeJS.ProcessEnv {
      ANTHROPIC_API_KEY?: string;
      OPENAI_BASE_URL?: string;
      OPENROUTER_API_KEY?: string;
      OPENAI_API_KEY?: string;
      MPP_PRIVATE_KEY?: string;
    }

    const env = (options.env ?? process.env) as ProviderEnv;
    const fetchImpl = options.fetchImpl ?? fetch;
    const streamImpl = options.streamTextImpl ?? streamText;
    const logger = log.child({ component: 'ai_sdk_backend' });

    const cfg = options.config;
    const ids = cfg.model.models;

    if (cfg.model.provider.kind === 'claude-code' || cfg.model.provider.kind === 'codex-cli') {
      throw new Error(
        `Provider "${cfg.model.provider.kind}" requires the CLI backend factory. Use createBackend().`,
      );
    }

    if (cfg.model.provider.kind === 'mpp') {
      await ensureMppClient(env);
      const rootBaseUrl = cfg.model.provider.baseUrl ?? 'https://mpp.tempo.xyz';
      const normalizedRoot = rootBaseUrl.replace(/\/+$/u, '');
      const mppOpenRouterBase = normalizedRoot.endsWith('/openrouter/v1')
        ? normalizedRoot
        : `${normalizedRoot}/openrouter/v1`;
      const providerInstance = createOpenAICompatible({
        name: 'mpp-openrouter',
        baseURL: mppOpenRouterBase,
      });
      const make = (role: ModelRole): ResolvedModel => {
        const id = ids[role];
        return { role, id, model: providerInstance.chatModel(id) };
      };
      return new AiSdkBackend({
        stream: streamImpl,
        defaultModel: make('default'),
        fastModel: make('fast'),
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
        defaultModel: make('default'),
        fastModel: make('fast'),
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
      return { role, id, model: providerInstance.chatModel(id) };
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
      defaultModel: make('default'),
      fastModel: make('fast'),
      embedder,
    });
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
      const result = this.stream({
        model: roleModel.model,
        providerOptions: roleModel.providerOptions as ProviderOptions,
        stopWhen: ({ steps }) => steps.length >= maxSteps,
        maxRetries: 3,
        timeout: { totalMs: 120_000, chunkMs: 15_000 },
        ...(Object.keys(tools).length ? { tools } : {}),
        messages: params.messages,
        ...(params.signal ? { abortSignal: params.signal } : {}),
      });

      const streamObserver = params.stream;
      let text = '';
      if (streamObserver) {
        text = await this.collectStreamTextAndEvents(result, streamObserver);
      } else {
        // AI SDK: `text` is a Promise<string>, `steps` is a Promise<...>, usage is best-effort.
        text = (await result.text).trim();
      }
      const usagePromise = (result as unknown as { totalUsage?: Promise<unknown> }).totalUsage;
      const usageRaw = usagePromise ? await usagePromise.catch(() => undefined) : undefined;
      const usage = usageRaw as
        | {
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
            inputTokenDetails?:
              | { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined }
              | undefined;
            outputTokenDetails?: { reasoningTokens?: number | undefined } | undefined;
          }
        | undefined;
      const usageCostUsd = extractUsageCostUsd(usageRaw);
      const usageTxHash = extractUsageTxHash(usageRaw);

      // Reset circuit breaker on success.
      this.circuit.failures = 0;
      this.circuit.openUntilMs = 0;

      // Keep our harness-level step log minimal for now.
      const steps = [{ type: 'llm' as const, text }];
      return {
        text,
        steps,
        modelId: roleModel.id,
        ...(usage || usageCostUsd !== undefined || usageTxHash
          ? {
              usage: {
                inputTokens: usage?.inputTokens ?? undefined,
                outputTokens: usage?.outputTokens ?? undefined,
                cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? undefined,
                cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? undefined,
                reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? undefined,
                costUsd: usageCostUsd ?? undefined,
                txHash: usageTxHash ?? undefined,
              },
            }
          : {}),
      };
    } catch (err) {
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

  private async collectStreamTextAndEvents(
    // AI SDK stream generics are provider/tool dependent; keep this helper generic.
    // biome-ignore lint/suspicious/noExplicitAny: generic SDK stream shape
    result: any,
    observer: CompletionStreamObserver,
  ): Promise<string> {
    const chunks: string[] = [];
    const extractString = (value: unknown): string => {
      if (typeof value === 'string') return value;
      return '';
    };
    const extractReasoningDelta = (part: unknown): string => {
      if (!part || typeof part !== 'object') return '';
      const candidate = part as {
        text?: unknown;
        delta?: unknown;
        reasoning?: unknown;
        content?: unknown;
      };
      const nestedDelta =
        candidate.delta && typeof candidate.delta === 'object'
          ? (candidate.delta as { text?: unknown; reasoning?: unknown; thinking?: unknown })
          : undefined;
      return (
        extractString(nestedDelta?.reasoning) ||
        extractString(nestedDelta?.thinking) ||
        extractString(nestedDelta?.text) ||
        extractString(candidate.reasoning) ||
        extractString(candidate.content) ||
        extractString(candidate.text) ||
        extractString(candidate.delta)
      );
    };
    let toolSeq = 0;
    const nextToolId = (): string => {
      toolSeq += 1;
      return `tool-${toolSeq}`;
    };

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        const delta = (part as { text?: string }).text ?? '';
        if (delta) {
          chunks.push(delta);
          observer.onTextDelta?.(delta);
        }
        continue;
      }

      if (part.type === 'tool-call') {
        const tool = part as { toolCallId?: string; toolName?: string; input?: unknown };
        observer.onToolCall?.({
          toolCallId: tool.toolCallId ?? nextToolId(),
          toolName: tool.toolName ?? 'tool',
          ...(tool.input !== undefined ? { input: tool.input } : {}),
        });
        continue;
      }

      if (part.type === 'tool-result') {
        const tool = part as { toolCallId?: string; toolName?: string; output?: unknown };
        observer.onToolResult?.({
          toolCallId: tool.toolCallId ?? nextToolId(),
          toolName: tool.toolName ?? 'tool',
          ...(tool.output !== undefined ? { output: tool.output } : {}),
        });
        continue;
      }

      if (
        typeof part.type === 'string' &&
        (part.type.includes('reasoning') || part.type.includes('thinking'))
      ) {
        const delta = extractReasoningDelta(part);
        if (delta) observer.onReasoningDelta?.(delta);
      }
    }

    const streamed = chunks.join('').trim();
    if (streamed) return streamed;

    const fallback = (await result.text).trim();
    if (fallback) observer.onTextDelta?.(fallback);
    return fallback;
  }
}
