import type {
  HomieBehaviorConfig,
  HomieConfig,
  HomieEngineConfig,
  HomieMemoryConfig,
  HomieModelConfig,
  HomieProactiveConfig,
  HomieToolsConfig,
} from './types.js';

const DEFAULT_SCHEMA_VERSION = 1;

export const getDefaultTimezone = (): string => {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
};

export const DEFAULT_BEHAVIOR: HomieBehaviorConfig = {
  sleep: {
    enabled: true,
    timezone: getDefaultTimezone(),
    startLocal: '23:00',
    endLocal: '07:00',
  },
  groupMaxChars: 240,
  dmMaxChars: 420,
  minDelayMs: 3_000,
  maxDelayMs: 18_000,
  debounceMs: 15_000,
};

export const DEFAULT_MODEL: HomieModelConfig = {
  provider: { kind: 'anthropic' },
  models: {
    default: 'claude-sonnet-4-5',
    fast: 'claude-haiku-4-5',
  },
};

export const DEFAULT_ENGINE: HomieEngineConfig = {
  limiter: {
    capacity: 3,
    refillPerSecond: 1,
  },
  perChatLimiter: {
    capacity: 5,
    refillPerSecond: 0.2,
    staleAfterMs: 600_000,
    sweepInterval: 50,
  },
  session: {
    fetchLimit: 200,
  },
  context: {
    maxTokensDefault: 8_000,
    identityPromptMaxTokens: 1_600,
    promptSkillsMaxTokens: 600,
  },
  generation: {
    reactiveMaxSteps: 20,
    proactiveMaxSteps: 10,
    maxRegens: 1,
  },
};

export const DEFAULT_PROACTIVE: HomieProactiveConfig = {
  enabled: false,
  heartbeatIntervalMs: 1_800_000,
  dm: {
    maxPerDay: 1,
    maxPerWeek: 3,
    cooldownAfterUserMs: 7_200_000,
    pauseAfterIgnored: 2,
  },
  group: {
    maxPerDay: 1,
    maxPerWeek: 1,
    cooldownAfterUserMs: 12 * 60 * 60_000,
    pauseAfterIgnored: 1,
  },
};

export const DEFAULT_MEMORY: HomieMemoryConfig = {
  enabled: true,
  contextBudgetTokens: 2000,
  capsule: { enabled: true, maxTokens: 200 },
  decay: { enabled: true, halfLifeDays: 30 },
  retrieval: {
    rrfK: 60,
    ftsWeight: 0.6,
    vecWeight: 0.4,
    recencyWeight: 0.2,
  },
  feedback: {
    enabled: true,
    finalizeAfterMs: 2 * 60 * 60_000,
    successThreshold: 0.6,
    failureThreshold: -0.3,
  },
  consolidation: {
    enabled: true,
    intervalMs: 6 * 60 * 60_000,
    modelRole: 'default',
    maxEpisodesPerRun: 50,
    dirtyGroupLimit: 3,
    dirtyPublicStyleLimit: 5,
    dirtyPersonLimit: 10,
  },
};

export const DEFAULT_TOOLS: HomieToolsConfig = {
  restricted: {
    enabledForOperator: true,
    allowlist: [],
  },
  dangerous: {
    enabledForOperator: false,
    allowAll: false,
    allowlist: [],
  },
};

export const createDefaultConfig = (projectDir: string): HomieConfig => {
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    model: DEFAULT_MODEL,
    engine: DEFAULT_ENGINE,
    behavior: DEFAULT_BEHAVIOR,
    proactive: DEFAULT_PROACTIVE,
    memory: DEFAULT_MEMORY,
    tools: DEFAULT_TOOLS,
    paths: {
      projectDir,
      identityDir: `${projectDir}/identity`,
      skillsDir: `${projectDir}/skills`,
      dataDir: `${projectDir}/data`,
    },
  };
};
