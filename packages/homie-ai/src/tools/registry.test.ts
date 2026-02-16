import { describe, expect, test } from 'bun:test';

import { createToolRegistry, getToolsForTier } from './registry.js';

describe('createToolRegistry', () => {
  test('returns safe tools', () => {
    const reg = createToolRegistry();
    const safe = getToolsForTier(reg, ['safe']);
    expect(safe.map((t) => t.name).sort()).toEqual([
      'calculator',
      'datetime',
      'read_url',
      'web_search',
    ]);
  });
});
