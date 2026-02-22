import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { defineTool } from './define.js';
import type { ToolContext } from './types.js';

describe('tools/defineTool', () => {
  const ctx = (overrides?: Partial<ToolContext>): ToolContext => ({
    now: new Date(),
    signal: new AbortController().signal,
    ...overrides,
  });

  test('enforces timeoutMs via abort signal', async () => {
    const tool = defineTool({
      name: 'hang',
      tier: 'safe',
      description: 'hang',
      timeoutMs: 5,
      inputSchema: z.object({}),
      execute: async (_input, _ctx) => {
        await new Promise<void>(() => {
          // never resolves
        });
      },
    });

    await expect(tool.execute({}, ctx())).rejects.toThrow('timed out');
  });

  test('propagates parent abort reason', async () => {
    const controller = new AbortController();
    const tool = defineTool({
      name: 'hang',
      tier: 'safe',
      description: 'hang',
      timeoutMs: 1000,
      inputSchema: z.object({}),
      execute: async (_input, _ctx) => {
        await new Promise<void>(() => {
          // never resolves
        });
      },
    });

    const p = tool.execute({}, ctx({ signal: controller.signal }));
    controller.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
  });

  test('parent abort beats timeout (when abort happens first)', async () => {
    const controller = new AbortController();
    const tool = defineTool({
      name: 'hang',
      tier: 'safe',
      description: 'hang',
      timeoutMs: 1000,
      inputSchema: z.object({}),
      execute: async (_input, _ctx) => {
        await new Promise<void>(() => {
          // never resolves
        });
      },
    });

    const p = tool.execute({}, ctx({ signal: controller.signal }));
    controller.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    await expect(p).rejects.not.toThrow('timed out');
  });

  test('throws helpful error on invalid tool input', async () => {
    const tool = defineTool({
      name: 'add',
      tier: 'safe',
      description: 'add',
      inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
      execute: ({ a, b }) => a + b,
    });

    await expect(tool.execute({ a: 1 }, ctx())).rejects.toThrow('Invalid tool input for add');
  });
});
