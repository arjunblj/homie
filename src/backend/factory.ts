import type { OpenhomieConfig } from '../config/types.js';
import type { FetchLike } from '../llm/ollama.js';
import type { Embedder } from '../memory/embeddings.js';
import { AiSdkBackend } from './ai-sdk.js';
import { ClaudeCodeBackend } from './claude-code.js';
import { CodexCliBackend } from './codex-cli.js';
import type { LLMBackend } from './types.js';

export interface CreateBackendOptions {
  config: OpenhomieConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

export interface CreatedBackend {
  backend: LLMBackend;
  embedder: Embedder | undefined;
}

export const createBackend = async (options: CreateBackendOptions): Promise<CreatedBackend> => {
  const provider = options.config.model.provider.kind;
  const models = options.config.model.models;
  if (provider === 'claude-code') {
    return {
      backend: new ClaudeCodeBackend({
        defaultModel: models.default,
        fastModel: models.fast,
      }),
      embedder: undefined,
    };
  }
  if (provider === 'codex-cli') {
    return {
      backend: new CodexCliBackend({
        defaultModel: models.default,
        fastModel: models.fast,
      }),
      embedder: undefined,
    };
  }

  const backend = await AiSdkBackend.create({
    config: options.config,
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { backend, embedder: backend.embedder };
};
