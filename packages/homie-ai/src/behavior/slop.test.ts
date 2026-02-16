import { describe, expect, test } from 'bun:test';

import { checkSlop } from './slop.js';

describe('checkSlop', () => {
  test('flags assistant-y phrasing', () => {
    const r = checkSlop("I'd be happy to help with that!");
    expect(r.isSlop).toBe(true);
    expect(r.violations.length).toBeGreaterThan(0);
  });

  test('does not flag normal short text', () => {
    const r = checkSlop('lol yeah');
    expect(r.isSlop).toBe(false);
  });
});
