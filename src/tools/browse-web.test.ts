import { describe, expect, test } from 'bun:test';

import { withMockEnv } from '../testing/mockEnv.js';
import { browseWebTool } from './browse-web.js';
import type { ToolContext } from './types.js';

const ctx = (): ToolContext => ({
  now: new Date(),
  signal: new AbortController().signal,
});

describe('browseWebTool', () => {
  test('returns not_configured when BROWSER_USE_API_KEY missing', async () => {
    await withMockEnv({ BROWSER_USE_API_KEY: undefined }, async () => {
      const out = (await browseWebTool.execute({ task: 'read something' }, ctx())) as {
        ok: boolean;
        error?: string;
      };
      expect(out.ok).toBe(false);
      expect(out.error).toContain('BROWSER_USE_API_KEY');
    });
  });
});
