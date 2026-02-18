import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ENGINE, DEFAULT_MEMORY } from '../config/defaults.js';
import type { HomieConfig } from '../config/types.js';

export async function createTestIdentity(dir: string): Promise<void> {
  await writeFile(path.join(dir, 'SOUL.md'), 'soul', 'utf8');
  await writeFile(path.join(dir, 'STYLE.md'), 'style', 'utf8');
  await writeFile(path.join(dir, 'USER.md'), 'user', 'utf8');
  await writeFile(path.join(dir, 'first-meeting.md'), 'hi', 'utf8');
  await writeFile(
    path.join(dir, 'personality.json'),
    JSON.stringify({ traits: ['x'], voiceRules: ['y'], antiPatterns: [] }),
    'utf8',
  );
}

export function createTestConfig(opts: {
  projectDir: string;
  identityDir: string;
  dataDir: string;
  overrides?: Partial<HomieConfig>;
}): HomieConfig {
  const { projectDir, identityDir, dataDir, overrides } = opts;
  return {
    schemaVersion: 1,
    model: {
      provider: { kind: 'anthropic' },
      models: { default: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' },
    },
    engine: DEFAULT_ENGINE,
    behavior: {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    },
    proactive: {
      enabled: false,
      heartbeatIntervalMs: 1_800_000,
      maxPerDay: 1,
      maxPerWeek: 3,
      cooldownAfterUserMs: 7_200_000,
      pauseAfterIgnored: 2,
    },
    memory: DEFAULT_MEMORY,
    tools: {
      restricted: { enabledForOperator: true, allowlist: [] },
      dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
    },
    paths: { projectDir, identityDir, skillsDir: path.join(projectDir, 'skills'), dataDir },
    ...overrides,
  };
}
