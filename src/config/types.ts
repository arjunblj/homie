import type { OpenhomieConfigFileParsed } from './zod.js';

export type OpenhomieConfigFile = OpenhomieConfigFileParsed;

export type ModelRole = 'default' | 'fast';

export type OpenhomieProvider =
  | { kind: 'anthropic' }
  | { kind: 'openai-compatible'; baseUrl?: string }
  | { kind: 'claude-code' }
  | { kind: 'codex-cli' }
  | { kind: 'mpp'; baseUrl: string };

export interface OpenhomieModelConfig {
  provider: OpenhomieProvider;
  models: Record<ModelRole, string>;
}

export interface OpenhomieBehaviorSleepConfig {
  enabled: boolean;
  timezone: string; // IANA tz, e.g. "America/Los_Angeles"
  startLocal: string; // "HH:MM"
  endLocal: string; // "HH:MM"
}

export interface OpenhomieBehaviorConfig {
  sleep: OpenhomieBehaviorSleepConfig;
  groupMaxChars: number;
  dmMaxChars: number;
  minDelayMs: number;
  maxDelayMs: number;
  debounceMs: number;
  /** If true, BEHAVIOR.md replaces built-in friend rules instead of appending. */
  overrideBuiltinRules: boolean;
}

export interface ProactiveRateLimits {
  maxPerDay: number;
  maxPerWeek: number;
  cooldownAfterUserMs: number;
  pauseAfterIgnored: number;
}

export interface OpenhomieProactiveConfig {
  enabled: boolean;
  heartbeatIntervalMs: number;
  /** Randomly skip some proactive events for anti-predictability. 0-1, default 0.30. */
  skipRate: number;
  dm: ProactiveRateLimits;
  group: ProactiveRateLimits;
}

export interface OpenhomieMemoryCapsuleConfig {
  enabled: boolean;
  maxTokens: number;
}

export interface OpenhomieMemoryDecayConfig {
  enabled: boolean;
  /** Half-life for relevance decay. Used to bias retrieval toward recent facts. */
  halfLifeDays: number;
}

export interface OpenhomieMemoryRetrievalConfig {
  /** Reciprocal-rank-fusion constant: score = 1 / (k + rank). */
  rrfK: number;
  /** Weight applied to the FTS rank contribution. */
  ftsWeight: number;
  /** Weight applied to the vector rank contribution. */
  vecWeight: number;
  /** Weight applied to the recency boost (computed from decay half-life). */
  recencyWeight: number;
}

export interface OpenhomieMemoryFeedbackConfig {
  enabled: boolean;
  /** Finalize a pending feedback record if nothing else happens before this timeout. */
  finalizeAfterMs: number;
  /** Score >= successThreshold yields a success lesson. */
  successThreshold: number;
  /** Score <= failureThreshold yields a failure lesson. */
  failureThreshold: number;
}

export interface OpenhomieMemoryConsolidationConfig {
  enabled: boolean;
  intervalMs: number;
  modelRole: ModelRole;
  maxEpisodesPerRun: number;
  dirtyGroupLimit: number;
  dirtyPublicStyleLimit: number;
  dirtyPersonLimit: number;
}

export interface OpenhomieMemoryConfig {
  enabled: boolean;
  /** Budget for the MEMORY CONTEXT section injected into the system prompt. */
  contextBudgetTokens: number;
  capsule: OpenhomieMemoryCapsuleConfig;
  decay: OpenhomieMemoryDecayConfig;
  retrieval: OpenhomieMemoryRetrievalConfig;
  feedback: OpenhomieMemoryFeedbackConfig;
  consolidation: OpenhomieMemoryConsolidationConfig;
}

export interface OpenhomieToolsConfig {
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

export interface OpenhomieEngineLimiterConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface OpenhomieEnginePerChatLimiterConfig {
  capacity: number;
  refillPerSecond: number;
  staleAfterMs: number;
  sweepInterval: number;
}

export interface OpenhomieEngineSessionConfig {
  fetchLimit: number;
}

export interface OpenhomieEngineContextConfig {
  maxTokensDefault: number;
  identityPromptMaxTokens: number;
  promptSkillsMaxTokens: number;
}

export interface OpenhomieEngineGenerationConfig {
  reactiveMaxSteps: number;
  proactiveMaxSteps: number;
  maxRegens: number;
}

export interface OpenhomieEngineConfig {
  limiter: OpenhomieEngineLimiterConfig;
  perChatLimiter: OpenhomieEnginePerChatLimiterConfig;
  session: OpenhomieEngineSessionConfig;
  context: OpenhomieEngineContextConfig;
  generation: OpenhomieEngineGenerationConfig;
}

export interface OpenhomiePathsConfig {
  projectDir: string;
  identityDir: string;
  skillsDir: string;
  dataDir: string;
}

export interface OpenhomieConfig {
  schemaVersion: number;
  model: OpenhomieModelConfig;
  engine: OpenhomieEngineConfig;
  behavior: OpenhomieBehaviorConfig;
  proactive: OpenhomieProactiveConfig;
  memory: OpenhomieMemoryConfig;
  tools: OpenhomieToolsConfig;
  paths: OpenhomiePathsConfig;
}
