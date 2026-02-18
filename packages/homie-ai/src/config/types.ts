import type { HomieConfigFileParsed } from './zod.js';

export type HomieConfigFile = HomieConfigFileParsed;

export type ModelRole = 'default' | 'fast';

export type HomieProvider = { kind: 'anthropic' } | { kind: 'openai-compatible'; baseUrl?: string };

export interface HomieModelConfig {
  provider: HomieProvider;
  models: Record<ModelRole, string>;
}

export interface HomieBehaviorSleepConfig {
  enabled: boolean;
  timezone: string; // IANA tz, e.g. "America/Los_Angeles"
  startLocal: string; // "HH:MM"
  endLocal: string; // "HH:MM"
}

export interface HomieBehaviorConfig {
  sleep: HomieBehaviorSleepConfig;
  groupMaxChars: number;
  dmMaxChars: number;
  minDelayMs: number;
  maxDelayMs: number;
  debounceMs: number;
}

export interface HomieProactiveConfig {
  enabled: boolean;
  heartbeatIntervalMs: number;
  maxPerDay: number;
  maxPerWeek: number;
  cooldownAfterUserMs: number;
  pauseAfterIgnored: number;
}

export interface HomieMemoryCapsuleConfig {
  enabled: boolean;
  maxTokens: number;
}

export interface HomieMemoryDecayConfig {
  enabled: boolean;
  /** Half-life for relevance decay. Used to bias retrieval toward recent facts. */
  halfLifeDays: number;
}

export interface HomieMemoryRetrievalConfig {
  /** Reciprocal-rank-fusion constant: score = 1 / (k + rank). */
  rrfK: number;
  /** Weight applied to the FTS rank contribution. */
  ftsWeight: number;
  /** Weight applied to the vector rank contribution. */
  vecWeight: number;
  /** Weight applied to the recency boost (computed from decay half-life). */
  recencyWeight: number;
}

export interface HomieMemoryFeedbackConfig {
  enabled: boolean;
  /** Finalize a pending feedback record if nothing else happens before this timeout. */
  finalizeAfterMs: number;
  /** Score >= successThreshold yields a success lesson. */
  successThreshold: number;
  /** Score <= failureThreshold yields a failure lesson. */
  failureThreshold: number;
}

export interface HomieMemoryConsolidationConfig {
  enabled: boolean;
  intervalMs: number;
  modelRole: ModelRole;
  maxEpisodesPerRun: number;
  dirtyGroupLimit: number;
  dirtyPublicStyleLimit: number;
  dirtyPersonLimit: number;
}

export interface HomieMemoryConfig {
  enabled: boolean;
  /** Budget for the MEMORY CONTEXT section injected into the system prompt. */
  contextBudgetTokens: number;
  capsule: HomieMemoryCapsuleConfig;
  decay: HomieMemoryDecayConfig;
  retrieval: HomieMemoryRetrievalConfig;
  feedback: HomieMemoryFeedbackConfig;
  consolidation: HomieMemoryConsolidationConfig;
}

export interface HomieToolsConfig {
  restricted: {
    enabledForOperator: boolean;
    /** If empty, all restricted tools are allowed (when enabled). */
    allowlist: string[];
  };
  dangerous: {
    enabledForOperator: boolean;
    /** If true, allow all dangerous tools (when enabledForOperator). Prefer allowlist. */
    allowAll: boolean;
    /** Tool name allowlist (applies when allowAll is false). */
    allowlist: string[];
  };
}

export interface HomieEngineLimiterConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface HomieEnginePerChatLimiterConfig {
  capacity: number;
  refillPerSecond: number;
  staleAfterMs: number;
  sweepInterval: number;
}

export interface HomieEngineSessionConfig {
  fetchLimit: number;
}

export interface HomieEngineContextConfig {
  maxTokensDefault: number;
  identityPromptMaxTokens: number;
  promptSkillsMaxTokens: number;
}

export interface HomieEngineGenerationConfig {
  reactiveMaxSteps: number;
  proactiveMaxSteps: number;
  maxRegens: number;
}

export interface HomieEngineConfig {
  limiter: HomieEngineLimiterConfig;
  perChatLimiter: HomieEnginePerChatLimiterConfig;
  session: HomieEngineSessionConfig;
  context: HomieEngineContextConfig;
  generation: HomieEngineGenerationConfig;
}

export interface HomiePathsConfig {
  projectDir: string;
  identityDir: string;
  skillsDir: string;
  dataDir: string;
}

export interface HomieConfig {
  schemaVersion: number;
  model: HomieModelConfig;
  engine: HomieEngineConfig;
  behavior: HomieBehaviorConfig;
  proactive: HomieProactiveConfig;
  memory: HomieMemoryConfig;
  tools: HomieToolsConfig;
  paths: HomiePathsConfig;
}
