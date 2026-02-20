import { describe, expect, test } from 'bun:test';
import { MPP_KEY_PATTERN, normalizeHttpUrl } from './mpp.js';

describe('normalizeHttpUrl', () => {
  test('prepends http:// when no protocol present', () => {
    expect(normalizeHttpUrl('localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeHttpUrl('127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
  });

  test('preserves existing protocol', () => {
    expect(normalizeHttpUrl('https://mpp.tempo.xyz')).toBe('https://mpp.tempo.xyz');
    expect(normalizeHttpUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  test('trims whitespace and strips trailing slashes', () => {
    expect(normalizeHttpUrl('  http://foo.com/  ')).toBe('http://foo.com');
    expect(normalizeHttpUrl('http://bar.com///')).toBe('http://bar.com');
  });

  test('returns empty string for empty input', () => {
    expect(normalizeHttpUrl('')).toBe('');
    expect(normalizeHttpUrl('   ')).toBe('');
  });
});

describe('MPP_KEY_PATTERN', () => {
  test('matches valid 0x-prefixed 64-char hex strings', () => {
    const valid = `0x${'a'.repeat(64)}`;
    expect(MPP_KEY_PATTERN.test(valid)).toBeTrue();
  });

  test('rejects invalid keys', () => {
    expect(MPP_KEY_PATTERN.test('abc123')).toBeFalse();
    expect(MPP_KEY_PATTERN.test(`0x${'g'.repeat(64)}`)).toBeFalse();
    expect(MPP_KEY_PATTERN.test(`0x${'a'.repeat(63)}`)).toBeFalse();
    expect(MPP_KEY_PATTERN.test('')).toBeFalse();
  });
});
