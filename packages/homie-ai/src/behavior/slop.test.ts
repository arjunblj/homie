import { describe, expect, test } from 'bun:test';

import { checkSlop, enforceMaxLength } from './slop.js';

describe('enforceMaxLength', () => {
  test('returns text unchanged when within limit', () => {
    expect(enforceMaxLength('hello', 100)).toBe('hello');
  });

  test('clips at word boundary when possible', () => {
    const result = enforceMaxLength('hello world this is a long message', 15);
    expect(result).toBe('hello world');
    expect(result.length).toBeLessThanOrEqual(15);
  });

  test('clips mid-word when no good word boundary exists', () => {
    const result = enforceMaxLength('abcdefghijklmnop', 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  test('handles exact limit', () => {
    expect(enforceMaxLength('hello', 5)).toBe('hello');
  });
});

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
