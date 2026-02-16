import type { z } from 'zod';

import { HomieConfigFileSchema } from './zod.js';

export type HomieConfigFile = z.output<typeof HomieConfigFileSchema>;

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

export interface HomieToolsConfig {
  shell: boolean;
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
  behavior: HomieBehaviorConfig;
  tools: HomieToolsConfig;
  paths: HomiePathsConfig;
}
