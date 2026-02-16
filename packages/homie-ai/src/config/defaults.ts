import type { HomieBehaviorConfig, HomieConfig, HomieModelConfig } from './types.js';

export const DEFAULT_SCHEMA_VERSION = 1;

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

export const DEFAULT_TOOLS = {
  shell: false,
};

export const createDefaultConfig = (projectDir: string): HomieConfig => {
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    model: DEFAULT_MODEL,
    behavior: DEFAULT_BEHAVIOR,
    tools: DEFAULT_TOOLS,
    paths: {
      projectDir,
      identityDir: `${projectDir}/identity`,
      skillsDir: `${projectDir}/skills`,
      dataDir: `${projectDir}/data`,
    },
  };
};
