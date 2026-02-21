import { describe, expect, test } from 'bun:test';
import { withTemporaryConfigPathEnv } from './runCli.js';

describe('withTemporaryConfigPathEnv', () => {
  const env = process.env as NodeJS.ProcessEnv & { OPENHOMIE_CONFIG_PATH?: string | undefined };

  test('sets OPENHOMIE_CONFIG_PATH for callback and restores undefined', async () => {
    const prior = env.OPENHOMIE_CONFIG_PATH;
    delete env.OPENHOMIE_CONFIG_PATH;
    try {
      let seen: string | undefined;
      await withTemporaryConfigPathEnv('/tmp/test-homie.toml', async () => {
        seen = env.OPENHOMIE_CONFIG_PATH;
      });
      expect(seen).toBe('/tmp/test-homie.toml');
      expect(env.OPENHOMIE_CONFIG_PATH).toBeUndefined();
    } finally {
      if (prior === undefined) delete env.OPENHOMIE_CONFIG_PATH;
      else env.OPENHOMIE_CONFIG_PATH = prior;
    }
  });

  test('restores prior OPENHOMIE_CONFIG_PATH value', async () => {
    const prior = env.OPENHOMIE_CONFIG_PATH;
    env.OPENHOMIE_CONFIG_PATH = '/tmp/prior-homie.toml';
    try {
      await withTemporaryConfigPathEnv('/tmp/new-homie.toml', async () => {
        expect(env.OPENHOMIE_CONFIG_PATH).toBe('/tmp/new-homie.toml');
      });
      expect(env.OPENHOMIE_CONFIG_PATH).toBe('/tmp/prior-homie.toml');
    } finally {
      if (prior === undefined) delete env.OPENHOMIE_CONFIG_PATH;
      else env.OPENHOMIE_CONFIG_PATH = prior;
    }
  });

  test('restores OPENHOMIE_CONFIG_PATH when callback throws', async () => {
    const prior = env.OPENHOMIE_CONFIG_PATH;
    delete env.OPENHOMIE_CONFIG_PATH;
    try {
      await expect(
        withTemporaryConfigPathEnv('/tmp/failing-homie.toml', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(env.OPENHOMIE_CONFIG_PATH).toBeUndefined();
    } finally {
      if (prior === undefined) delete env.OPENHOMIE_CONFIG_PATH;
      else env.OPENHOMIE_CONFIG_PATH = prior;
    }
  });
});
