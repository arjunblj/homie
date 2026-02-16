import { describe, expect, test } from 'bun:test';

import type { HomieConfig } from '../config/types.js';
import { createProviderRegistry } from './registry.js';

const baseConfig = (overrides: Partial<HomieConfig>): HomieConfig => {
  const projectDir = '/tmp/project';
  return {
    schemaVersion: 1,
    model: {
      provider: { kind: 'anthropic' },
      models: { default: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' },
    },
    behavior: {
      sleep: { enabled: true, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 3_000,
      maxDelayMs: 18_000,
      debounceMs: 15_000,
    },
    tools: { shell: false },
    paths: {
      projectDir,
      identityDir: `${projectDir}/identity`,
      skillsDir: `${projectDir}/skills`,
      dataDir: `${projectDir}/data`,
    },
    ...overrides,
  };
};

describe('createProviderRegistry', () => {
  test('requires ANTHROPIC_API_KEY for anthropic provider', async () => {
    const config = baseConfig({});
    await expect(createProviderRegistry({ config, env: {} })).rejects.toThrow(/ANTHROPIC_API_KEY/u);
  });

  test('requires OPENROUTER_API_KEY for OpenRouter baseURL', async () => {
    const config = baseConfig({
      model: {
        provider: { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
        models: { default: 'google/gemini-2.0-flash', fast: 'google/gemini-2.0-flash' },
      },
    });
    await expect(createProviderRegistry({ config, env: {} })).rejects.toThrow(
      /OPENROUTER_API_KEY/u,
    );
  });

  test('probes Ollama when selected', async () => {
    const config = baseConfig({
      model: {
        provider: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
        models: { default: 'qwen3:8b', fast: 'qwen3:8b' },
      },
    });

    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input));
      return new Response(JSON.stringify({ version: '0.0.0' }), { status: 200 });
    };

    const reg = await createProviderRegistry({ config, env: {}, fetchImpl });
    expect(reg.defaultModel.id).toBe('qwen3:8b');
    expect(calls.some((c) => c.includes('/api/version'))).toBe(true);
  });
});
