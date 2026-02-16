import { describe, expect, test } from 'bun:test';

import { probeOllama } from './ollama.js';

describe('probeOllama', () => {
  test('probes /api/version (strips /v1)', async () => {
    let gotUrl = '';
    await probeOllama('http://localhost:11434/v1', async (input) => {
      gotUrl = String(input);
      return new Response('{"version":"x"}', { status: 200 });
    });
    expect(gotUrl).toBe('http://localhost:11434/api/version');
  });

  test('probes /api/version (no /v1 in base url)', async () => {
    let gotUrl = '';
    await probeOllama('http://localhost:11434', async (input) => {
      gotUrl = String(input);
      return new Response('{"version":"x"}', { status: 200 });
    });
    expect(gotUrl).toBe('http://localhost:11434/api/version');
  });

  test('throws on non-200', async () => {
    await expect(
      probeOllama('http://localhost:11434/v1', async () => new Response('nope', { status: 500 })),
    ).rejects.toThrow('Ollama probe returned HTTP 500');
  });

  test('throws on fetch error', async () => {
    await expect(
      probeOllama('http://localhost:11434/v1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('Ollama probe failed: boom');
  });

  test(
    'aborts slow probes',
    async () => {
      await expect(
        probeOllama('http://localhost:11434', async (_url, init) => {
          return await new Promise<Response>((_resolve, reject) => {
            const sig = init?.signal;
            if (!sig) reject(new Error('missing signal'));
            sig?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }),
      ).rejects.toThrow('aborted');
    },
    5_000,
  );
});

