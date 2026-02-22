import { describe, expect, test } from 'bun:test';

import { createToolRegistry, getToolsForTier } from './registry.js';

describe('createToolRegistry', () => {
  test('returns safe tools', async () => {
    const reg = await createToolRegistry();
    const safe = getToolsForTier(reg, ['safe']);
    const names = safe.map((t) => t.name);
    // Contract: these built-ins must always exist as safe tools.
    for (const required of [
      'datetime',
      'describe_image',
      'read_url',
      'transcribe_audio',
      'web_search',
    ]) {
      expect(names).toContain(required);
    }
    // Avoid brittle coupling to the full list; new safe tools should not break this test.
    expect(new Set(names).size).toBe(names.length);
  });
});
