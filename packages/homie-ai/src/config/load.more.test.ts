import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadHomieConfig } from './load.js';

describe('loadHomieConfig (more)', () => {
  test('throws when homie.toml not found', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-noconfig-'));
    try {
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow(
        'Could not find homie.toml',
      );
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
        ['schema_version = 1', '', '[behavior]', 'min_delay_ms = 10', 'max_delay_ms = 0', ''].join(
          '\n',
        ),
        'utf8',
      );
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('min_delay_ms');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('wraps malformed TOML errors with actionable message', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-toml-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(cfgPath, ['schema_version = 1', 'oops = ', ''].join('\n'), 'utf8');
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('Malformed homie.toml');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('rejects path traversal escapes in config paths', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-path-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(
        cfgPath,
        ['schema_version = 1', '', '[paths]', 'identity_dir = "../escape"', ''].join('\n'),
        'utf8',
      );
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('paths.identity_dir');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('rejects absolute paths outside the project directory', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-abspath-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(
        cfgPath,
        ['schema_version = 1', '', '[paths]', 'data_dir = "/tmp"', ''].join('\n'),
        'utf8',
      );
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('paths.data_dir');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('rejects invalid IANA time zones', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-tz-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(cfgPath, ['schema_version = 1', ''].join('\n'), 'utf8');
      await expect(
        loadHomieConfig({
          cwd: tmp,
          env: {
            HOMIE_TIMEZONE: 'Not/AZone',
          },
        }),
      ).rejects.toThrow('Invalid time zone');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('treats blank model env vars as unset (fallbacks remain non-empty)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-blank-model-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(
        cfgPath,
        [
          'schema_version = 1',
          '',
          '[model]',
          'provider = "anthropic"',
          'default = "claude-file"',
          '',
        ].join('\n'),
        'utf8',
      );
      const { config } = await loadHomieConfig({
        cwd: tmp,
        env: {
          HOMIE_MODEL_DEFAULT: '   ',
          HOMIE_MODEL_FAST: ' \n ',
          HOMIE_TIMEZONE: 'UTC',
        },
      });
      expect(config.model.models.default).toBe('claude-file');
      expect(config.model.models.fast).toBe('claude-file');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('rejects negative numeric env overrides', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-num-env-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(cfgPath, ['schema_version = 1', ''].join('\n'), 'utf8');
      await expect(
        loadHomieConfig({
          cwd: tmp,
          env: {
            HOMIE_ENGINE_LIMITER_CAPACITY: '-1',
            HOMIE_TIMEZONE: 'UTC',
          },
        }),
      ).rejects.toThrow('engine.limiter.capacity');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('rejects absurdly large numeric env overrides', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-num-env-big-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(cfgPath, ['schema_version = 1', ''].join('\n'), 'utf8');
      await expect(
        loadHomieConfig({
          cwd: tmp,
          env: {
            HOMIE_ENGINE_CONTEXT_MAX_TOKENS_DEFAULT: '999999999',
            HOMIE_TIMEZONE: 'UTC',
          },
        }),
      ).rejects.toThrow('engine.context.maxTokensDefault');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('rejects out-of-range file thresholds', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-threshold-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(
        cfgPath,
        ['schema_version = 1', '', '[memory]', 'feedback_success_threshold = 2', ''].join('\n'),
        'utf8',
      );
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('Invalid homie.toml');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('resolves provider aliases and parses falsey sleep env values', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-provider-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(
        cfgPath,
        ['schema_version = 1', '', '[model]', 'provider = "anthropic"', ''].join('\n'),
        'utf8',
      );

      const { config } = await loadHomieConfig({
        cwd: tmp,
        env: {
          HOMIE_MODEL_PROVIDER: 'openrouter',
          HOMIE_SLEEP_MODE: '0',
          HOMIE_TIMEZONE: 'UTC',
        },
      });

      expect(config.model.provider.kind).toBe('openai-compatible');
      if (config.model.provider.kind !== 'openai-compatible')
        throw new Error('expected openai-compatible');
      expect(config.model.provider.baseUrl).toContain('openrouter.ai');
      expect(config.behavior.sleep.enabled).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('resolves openai provider alias to OpenAI base URL', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-provider-openai-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(cfgPath, ['schema_version = 1', ''].join('\n'), 'utf8');

      const { config } = await loadHomieConfig({
        cwd: tmp,
        env: { HOMIE_MODEL_PROVIDER: 'openai', HOMIE_TIMEZONE: 'UTC' },
      });

      expect(config.model.provider.kind).toBe('openai-compatible');
      if (config.model.provider.kind !== 'openai-compatible') {
        throw new Error('expected openai-compatible');
      }
      expect(config.model.provider.baseUrl).toBe('https://api.openai.com/v1');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('resolves mpp provider alias with default base URL', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-provider-mpp-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(cfgPath, ['schema_version = 1', ''].join('\n'), 'utf8');

      const { config } = await loadHomieConfig({
        cwd: tmp,
        env: { HOMIE_MODEL_PROVIDER: 'mpp', HOMIE_TIMEZONE: 'UTC' },
      });

      expect(config.model.provider.kind).toBe('mpp');
      if (config.model.provider.kind !== 'mpp') {
        throw new Error('expected mpp');
      }
      expect(config.model.provider.baseUrl).toBe('https://mpp.tempo.xyz');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('resolves claude_code and codex aliases', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-provider-cli-aliases-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(cfgPath, ['schema_version = 1', ''].join('\n'), 'utf8');

      const claude = await loadHomieConfig({
        cwd: tmp,
        env: { HOMIE_MODEL_PROVIDER: 'claude_code', HOMIE_TIMEZONE: 'UTC' },
      });
      expect(claude.config.model.provider.kind).toBe('claude-code');

      const codex = await loadHomieConfig({
        cwd: tmp,
        env: { HOMIE_MODEL_PROVIDER: 'codex', HOMIE_TIMEZONE: 'UTC' },
      });
      expect(codex.config.model.provider.kind).toBe('codex-cli');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('rejects invalid sleep_start format in TOML', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-sleep-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(
        cfgPath,
        ['schema_version = 1', '', '[behavior]', 'sleep_start = "abc"', ''].join('\n'),
        'utf8',
      );
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('Invalid homie.toml');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('rejects out-of-range sleep hours in TOML (Zod catches 25:00)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-sleep-hr-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(
        cfgPath,
        ['schema_version = 1', '', '[behavior]', 'sleep_start = "25:00"', ''].join('\n'),
        'utf8',
      );
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('Invalid homie.toml');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('rejects out-of-range sleep minutes in TOML (Zod catches 12:99)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bad-sleep-min-'));
    try {
      const cfgPath = path.join(tmp, 'homie.toml');
      await writeFile(
        cfgPath,
        ['schema_version = 1', '', '[behavior]', 'sleep_end = "12:99"', ''].join('\n'),
        'utf8',
      );
      await expect(loadHomieConfig({ cwd: tmp, env: {} })).rejects.toThrow('Invalid homie.toml');
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
      if (config.model.provider.kind !== 'openai-compatible')
        throw new Error('expected openai-compatible');
      expect(config.model.provider.baseUrl).toBe('http://example.test/v1');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
