import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import type { HomieConfig, ModelRole } from '../config/types.js';
import { type FetchLike, probeOllama } from './ollama.js';
import { getAnthropicThinking } from './thinking.js';

export interface ResolvedModelRole {
  role: ModelRole;
  id: string;
  model: LanguageModel;
  providerOptions?: Record<string, unknown>;
}

export interface ProviderRegistry {
  defaultModel: ResolvedModelRole;
  fastModel: ResolvedModelRole;
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

export interface CreateProviderRegistryOptions {
  config: HomieConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

export const createProviderRegistry = async (
  options: CreateProviderRegistryOptions,
): Promise<ProviderRegistry> => {
  interface ProviderEnv extends NodeJS.ProcessEnv {
    ANTHROPIC_API_KEY?: string;
    OPENAI_BASE_URL?: string;
    OPENROUTER_API_KEY?: string;
    OPENAI_API_KEY?: string;
  }

  const env = (options.env ?? process.env) as ProviderEnv;
  const fetchImpl = options.fetchImpl ?? fetch;

  const provider = options.config.model.provider;
  const ids = options.config.model.models;

  if (provider.kind === 'anthropic') {
    // Even though @ai-sdk/anthropic can read env implicitly, we validate up-front.
    requireEnv(env, 'ANTHROPIC_API_KEY', 'Set it in your environment or .env file.');

    const make = (role: ModelRole): ResolvedModelRole => {
      const id = ids[role];
      const thinking = getAnthropicThinking(id, role);
      const base: ResolvedModelRole = { role, id, model: anthropic(id) };
      if (!thinking) return base;
      return { ...base, providerOptions: { anthropic: { thinking } } };
    };

    return { defaultModel: make('default'), fastModel: make('fast') };
  }

  // OpenAI-compatible provider (OpenRouter, Ollama, OpenAI, vLLM, etc)
  const baseURL = provider.baseUrl ?? env.OPENAI_BASE_URL;
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
    // Generic OpenAI-compatible endpoints usually require a bearer token.
    apiKey = env.OPENAI_API_KEY?.trim() || undefined;
  }

  const providerInstance = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL,
    ...(apiKey ? { apiKey } : {}),
  });

  const make = (role: ModelRole): ResolvedModelRole => {
    const id = ids[role];
    return { role, id, model: providerInstance.chatModel(id) };
  };

  return { defaultModel: make('default'), fastModel: make('fast') };
};
