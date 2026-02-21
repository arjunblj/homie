import { describe, expect, test } from 'bun:test';

import { createDefaultConfig } from '../config/defaults.js';
import type { OpenhomieConfig } from '../config/types.js';
import { createBackend } from './factory.js';

const withProvider = (provider: OpenhomieConfig['model']['provider']): OpenhomieConfig => {
  const base = createDefaultConfig('/tmp/factory-test');
  return {
    ...base,
    model: {
      ...base.model,
      provider,
    },
  };
};

describe('createBackend', () => {
  test('returns claude-code backend for claude-code provider', async () => {
    const created = await createBackend({ config: withProvider({ kind: 'claude-code' }) });
    expect(created.backend).toBeDefined();
    expect(created.embedder).toBeUndefined();
  });

  test('returns codex-cli backend for codex-cli provider', async () => {
    const created = await createBackend({ config: withProvider({ kind: 'codex-cli' }) });
    expect(created.backend).toBeDefined();
    expect(created.embedder).toBeUndefined();
  });

  test('routes mpp provider through ai-sdk backend', async () => {
    await expect(
      createBackend({
        config: withProvider({ kind: 'mpp', baseUrl: 'https://mpp.tempo.xyz' }),
        env: {},
      }),
    ).rejects.toThrow('MPP_PRIVATE_KEY');
  });
});
