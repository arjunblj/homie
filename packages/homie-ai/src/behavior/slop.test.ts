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

  test('flags emoji in message text', () => {
    const r = checkSlop('that was wild 😂');
    expect(r.violations.some((v) => v.category === 'emoji_in_text')).toBe(true);
  });

  test('flags em dash overuse', () => {
    const r = checkSlop('ok -- wait -- what -- lol');
    expect(r.violations.some((v) => v.category === 'em_dash_overuse')).toBe(true);
  });
});
