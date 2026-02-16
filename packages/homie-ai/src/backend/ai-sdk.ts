import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type Tool as AiTool, type LanguageModel, streamText, tool } from 'ai';

import type { HomieConfig, ModelRole } from '../config/types.js';
import { type FetchLike, probeOllama } from '../llm/ollama.js';
import { getAnthropicThinking } from '../llm/thinking.js';
import type { ToolDef } from '../tools/types.js';
import type { CompleteParams, CompletionResult, LLMBackend } from './types.js';

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

const requireEnv = (env: NodeJS.ProcessEnv, key: string, hint: string): string => {
  const value = env[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing ${key}. ${hint}`);
};

const toolDefsToAiTools = (defs: readonly ToolDef[] | undefined): Record<string, AiTool> => {
  const out: Record<string, AiTool> = {};
  if (!defs) return out;

  for (const def of defs) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input) => def.execute(input, { now: new Date() }),
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
  private readonly stream: typeof streamText;
  private readonly defaultModel: ResolvedModel;
  private readonly fastModel: ResolvedModel;

  private constructor(opts: {
    stream: typeof streamText;
    defaultModel: ResolvedModel;
    fastModel: ResolvedModel;
  }) {
    this.stream = opts.stream;
    this.defaultModel = opts.defaultModel;
    this.fastModel = opts.fastModel;
  }

  public static async create(options: CreateAiSdkBackendOptions): Promise<AiSdkBackend> {
    interface ProviderEnv extends NodeJS.ProcessEnv {
      ANTHROPIC_API_KEY?: string;
      OPENAI_BASE_URL?: string;
      OPENROUTER_API_KEY?: string;
      OPENAI_API_KEY?: string;
    }

    const env = (options.env ?? process.env) as ProviderEnv;
    const fetchImpl = options.fetchImpl ?? fetch;
    const streamImpl = options.streamTextImpl ?? streamText;

    const cfg = options.config;
    const ids = cfg.model.models;

    if (cfg.model.provider.kind === 'anthropic') {
      requireEnv(env, 'ANTHROPIC_API_KEY', 'Set it in your environment or .env file.');

      const make = (role: ModelRole): ResolvedModel => {
        const id = ids[role];
        const thinking = getAnthropicThinking(id, role);
        const base: ResolvedModel = { role, id, model: anthropic(id) };
        if (!thinking) return base;
        return { ...base, providerOptions: { anthropic: { thinking } } };
      };

      return new AiSdkBackend({
        stream: streamImpl,
        defaultModel: make('default'),
        fastModel: make('fast'),
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

    return new AiSdkBackend({
      stream: streamImpl,
      defaultModel: make('default'),
      fastModel: make('fast'),
    });
  }

  public async complete(params: CompleteParams): Promise<CompletionResult> {
    const roleModel = params.role === 'fast' ? this.fastModel : this.defaultModel;

    const maxSteps = params.maxSteps;
    const tools = toolDefsToAiTools(params.tools);

    type StreamTextArgs = Parameters<typeof streamText>[0];
    type ProviderOptions = StreamTextArgs extends { providerOptions?: infer P } ? P : never;

    const result = this.stream({
      model: roleModel.model,
      providerOptions: roleModel.providerOptions as ProviderOptions,
      stopWhen: ({ steps }) => steps.length >= maxSteps,
      ...(Object.keys(tools).length ? { tools } : {}),
      messages: params.messages,
      ...(params.signal ? { abortSignal: params.signal } : {}),
    });

    // AI SDK: `text` is a Promise<string>, `steps` is a Promise<...>, usage is best-effort.
    const text = (await result.text).trim();

    // Keep our harness-level step log minimal for now.
    const steps = [{ type: 'llm' as const, text }];
    return { text, steps };
  }
}
