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

  test('flags numbered list as structural tell', () => {
    const r = checkSlop('1. first thing\n2. second thing');
    expect(r.violations.some((v) => v.category === 'structural_tell')).toBe(true);
  });

  test('flags bullet list as structural tell', () => {
    const r = checkSlop('sure:\n- option one\n- option two');
    expect(r.violations.some((v) => v.category === 'structural_tell')).toBe(true);
  });

  test('flags multiple paragraphs as structural tell', () => {
    const r = checkSlop('First paragraph here.\n\nSecond paragraph here.\n\nThird one.');
    expect(r.violations.some((v) => v.category === 'structural_tell')).toBe(true);
  });

  test('flags rule-of-three list pattern', () => {
    const r = checkSlop('it combines speed, accuracy, reliability, and durability');
    expect(r.violations.some((v) => v.category === 'rule_of_three')).toBe(true);
  });

  test('does not flag simple "and" without comma list', () => {
    const r = checkSlop('yeah i went to the store and got stuff');
    expect(r.violations.some((v) => v.category === 'rule_of_three')).toBe(false);
  });

  test('flags meta-commentary about internal state', () => {
    const r = checkSlop('according to my notes you like pizza');
    expect(r.violations.some((v) => v.category === 'meta_commentary')).toBe(true);
  });

  test('does not flag casual "I checked the time"', () => {
    const r = checkSlop('i just checked the time');
    expect(r.violations.some((v) => v.category === 'meta_commentary')).toBe(false);
  });

  test('does not flag casual "I looked at it"', () => {
    const r = checkSlop('i looked at it and it seems fine');
    expect(r.violations.some((v) => v.category === 'meta_commentary')).toBe(false);
  });

  test('flags multiple exclamation marks', () => {
    const r = checkSlop('that is so amazing!!');
    expect(r.violations.some((v) => v.category === 'forced_enthusiasm')).toBe(true);
  });

  test('flags forced greeting enthusiasm', () => {
    const r = checkSlop('Oh! That reminds me');
    expect(r.violations.some((v) => v.category === 'forced_enthusiasm')).toBe(true);
  });

  test('does not flag normal greeting without exclamation', () => {
    const r = checkSlop('hey whats up');
    expect(r.violations.some((v) => v.category === 'forced_enthusiasm')).toBe(false);
  });
});
