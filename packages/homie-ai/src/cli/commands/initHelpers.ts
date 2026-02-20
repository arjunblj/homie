import { tmpdir } from 'node:os';
import path from 'node:path';

import type { HomieConfig, HomieProvider } from '../../config/types.js';
import type { InitProvider } from '../../llm/detect.js';

interface MakeTempConfigOptions {
  baseUrl?: string | undefined;
}

const mapInitProviderToHomieProvider = (
  provider: InitProvider,
  options?: MakeTempConfigOptions,
): HomieProvider => {
  if (provider === 'openrouter') {
    return { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' };
  }
  if (provider === 'openai') {
    return { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' };
  }
  if (provider === 'ollama') {
    return { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' };
  }
  if (provider === 'mpp') {
    return { kind: 'mpp', baseUrl: options?.baseUrl?.trim() || 'https://mpp.tempo.xyz' };
  }
  if (provider === 'anthropic') return { kind: 'anthropic' };
  if (provider === 'claude-code') return { kind: 'claude-code' };
  return { kind: 'codex-cli' };
};

export const makeTempConfig = (
  provider: InitProvider,
  modelDefault: string,
  modelFast: string,
  options?: MakeTempConfigOptions,
): HomieConfig => ({
  schemaVersion: 1,
  model: {
    provider: mapInitProviderToHomieProvider(provider, options),
    models: { default: modelDefault, fast: modelFast },
  },
  engine: {
    limiter: { capacity: 100, refillPerSecond: 1 },
    perChatLimiter: { capacity: 100, refillPerSecond: 1, staleAfterMs: 60_000, sweepInterval: 100 },
    session: { fetchLimit: 100 },
    context: { maxTokensDefault: 4000, identityPromptMaxTokens: 2000, promptSkillsMaxTokens: 1000 },
    generation: { reactiveMaxSteps: 5, proactiveMaxSteps: 5, maxRegens: 2 },
  },
  behavior: {
    sleep: { enabled: false, timezone: 'UTC', startLocal: '22:00', endLocal: '08:00' },
    groupMaxChars: 500,
    dmMaxChars: 500,
    minDelayMs: 0,
    maxDelayMs: 0,
    debounceMs: 0,
  },
  proactive: {
    enabled: false,
    heartbeatIntervalMs: 0,
    dm: { maxPerDay: 0, maxPerWeek: 0, cooldownAfterUserMs: 0, pauseAfterIgnored: 0 },
    group: { maxPerDay: 0, maxPerWeek: 0, cooldownAfterUserMs: 0, pauseAfterIgnored: 0 },
  },
  memory: {
    enabled: false,
    contextBudgetTokens: 0,
    capsule: { enabled: false, maxTokens: 0 },
    decay: { enabled: false, halfLifeDays: 0 },
    retrieval: { rrfK: 0, ftsWeight: 0, vecWeight: 0, recencyWeight: 0 },
    feedback: { enabled: false, finalizeAfterMs: 0, successThreshold: 0, failureThreshold: 0 },
    consolidation: {
      enabled: false,
      intervalMs: 0,
      modelRole: 'fast',
      maxEpisodesPerRun: 0,
      dirtyGroupLimit: 0,
      dirtyPublicStyleLimit: 0,
      dirtyPersonLimit: 0,
    },
  },
  tools: {
    restricted: { enabledForOperator: false, allowlist: [] },
    dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
  },
  paths: {
    projectDir: path.join(tmpdir(), 'homie-temp'),
    identityDir: path.join(tmpdir(), 'homie-temp', 'identity'),
    skillsDir: path.join(tmpdir(), 'homie-temp', 'skills'),
    dataDir: path.join(tmpdir(), 'homie-temp', 'data'),
  },
});
