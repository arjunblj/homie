import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadHomieConfig } from './load.js';

let tmpDir: string | null = null;

afterEach(async () => {
  if (!tmpDir) return;
  const dir = tmpDir;
  tmpDir = null;
  await rm(dir, { recursive: true, force: true });
});

const makeProject = async (toml: string): Promise<{ dir: string; configPath: string }> => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'homie-'));
  const configPath = path.join(tmpDir, 'homie.toml');
  await writeFile(configPath, toml, 'utf8');
  return { dir: tmpDir, configPath };
};

describe('loadHomieConfig', () => {
  test('loads defaults and file overrides', async () => {
    const { dir, configPath } = await makeProject(`
schema_version = 1

[model]
provider = "anthropic"
default = "claude-foo"

[behavior]
sleep_mode = true
sleep_start = "22:30"
sleep_end = "06:30"
group_max_chars = 111
`);

    const { config } = await loadHomieConfig({ cwd: dir, configPath, env: {} });
    expect(config.schemaVersion).toBe(1);
    expect(config.model.models.default).toBe('claude-foo');
    expect(config.model.models.fast).toBe('claude-foo');

    expect(config.behavior.sleep.enabled).toBe(true);
    expect(config.behavior.sleep.startLocal).toBe('22:30');
    expect(config.behavior.sleep.endLocal).toBe('06:30');
    expect(config.behavior.groupMaxChars).toBe(111);

    expect(config.behavior.dmMaxChars).toBeGreaterThan(0);
    expect(config.behavior.minDelayMs).toBeGreaterThanOrEqual(0);
    expect(config.behavior.maxDelayMs).toBeGreaterThanOrEqual(config.behavior.minDelayMs);
  });

  test('env overrides win over file', async () => {
    const { dir, configPath } = await makeProject(`
[model]
provider = "anthropic"
default = "claude-file"
fast = "claude-fast-file"

[tools]
shell = false
`);

    const { config } = await loadHomieConfig({
      cwd: dir,
      configPath,
      env: {
        HOMIE_MODEL_DEFAULT: 'claude-env',
        HOMIE_MODEL_FAST: 'claude-fast-env',
        HOMIE_TOOLS_SHELL: 'true',
        HOMIE_TIMEZONE: 'UTC',
      },
    });

    expect(config.model.models.default).toBe('claude-env');
    expect(config.model.models.fast).toBe('claude-fast-env');
    expect(config.tools.shell).toBe(true);
    expect(config.behavior.sleep.timezone).toBe('UTC');
  });
});
