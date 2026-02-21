import { describe, expect, test } from 'bun:test';

import { createToolRegistry, getToolsForTier } from './registry.js';

describe('createToolRegistry', () => {
  test('returns safe tools', async () => {
    const reg = await createToolRegistry();
    const safe = getToolsForTier(reg, ['safe']);
    expect(safe.map((t) => t.name).sort()).toEqual([
      'datetime',
      'describe_image',
      'read_url',
      'transcribe_audio',
      'web_search',
    ]);
  });
});
