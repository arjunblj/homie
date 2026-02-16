import { describe, expect, test } from 'bun:test';

import { truncateBytes, wrapExternal } from './util.js';

describe('tools/util', () => {
  test('wrapExternal strips XML-unsafe title chars', () => {
    const out = wrapExternal('<hi&bye>', 'content');
    expect(out).toContain('<external title="hibye">');
    expect(out).toContain('content');
    expect(out).toContain('</external>');
  });

  test('truncateBytes truncates by UTF-8 byte length', () => {
    const s = 'hello world';
    expect(truncateBytes(s, 100)).toBe(s);
    expect(truncateBytes(s, 5)).toBe('hello');
  });
});
