import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadHomieConfig } from './load.js';

describe('loadHomieConfig (more)', () => {
  test('throws when homie.toml not found', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-noconfig-'));
    try {
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('Could not find homie.toml');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('throws when min_delay_ms > max_delay_ms', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-delay-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(
        cfgPath,
        ['schema_version = 1', '', '[behavior]', 'min_delay_ms = 10', 'max_delay_ms = 0', ''].join('\n'),
        'utf8',
      );
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('min_delay_ms');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('resolves provider aliases and parses falsey sleep env values', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-provider-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(cfgPath, ['schema_version = 1', '', '[model]', 'provider = "anthropic"', ''].join('\n'), 'utf8');

      const { config } = await loadHomieConfig({
        cwd: tmp,
        env: {
          HOMIE_MODEL_PROVIDER: 'openrouter',
          HOMIE_SLEEP_MODE: '0',
          HOMIE_TIMEZONE: 'UTC',
        },
      });

      expect(config.model.provider.kind).toBe('openai-compatible');
      if (config.model.provider.kind !== 'openai-compatible') throw new Error('expected openai-compatible');
      expect(config.model.provider.baseUrl).toContain('openrouter.ai');
      expect(config.behavior.sleep.enabled).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('falls back to openai-compatible when provider is unknown', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-provider-unknown-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(cfgPath, ['schema_version = 1', ''].join('\n'), 'utf8');

      const { config } = await loadHomieConfig({
        cwd: tmp,
        env: { HOMIE_MODEL_PROVIDER: 'weird', HOMIE_MODEL_BASE_URL: 'http://example.test/v1' },
      });

      expect(config.model.provider.kind).toBe('openai-compatible');
      if (config.model.provider.kind !== 'openai-compatible') throw new Error('expected openai-compatible');
      expect(config.model.provider.baseUrl).toBe('http://example.test/v1');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

