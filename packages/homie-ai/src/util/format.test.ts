import { describe, expect, test } from 'bun:test';
import { errorMessage, formatUsd, shortAddress, shortTxHash, truncateText } from './format.js';

describe('errorMessage', () => {
  test('extracts message from Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  test('stringifies non-Error values', () => {
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });
});

describe('truncateText', () => {
  test('returns original when within limit', () => {
    expect(truncateText('hi', 10)).toBe('hi');
  });

  test('truncates with ellipsis at boundary', () => {
    expect(truncateText('hello world', 5)).toBe('hello…');
  });
});

describe('formatUsd', () => {
  test('returns $0.00 for zero and non-finite', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(NaN)).toBe('$0.00');
    expect(formatUsd(Infinity)).toBe('$0.00');
  });

  test('handles negatives', () => {
    expect(formatUsd(-1.5)).toBe('-$1.50');
  });

  test('formats with appropriate precision tiers', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(0.055)).toBe('$0.055');
    expect(formatUsd(0.0012)).toBe('$0.0012');
  });
});

describe('shortAddress', () => {
  test('passes through short strings unchanged', () => {
    expect(shortAddress('0x1234')).toBe('0x1234');
  });

  test('truncates standard 42-char addresses', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    const short = shortAddress(addr);
    expect(short).toBe('0x1234...5678');
    expect(short.length).toBeLessThan(addr.length);
  });
});

describe('shortTxHash', () => {
  test('passes through short strings unchanged', () => {
    expect(shortTxHash('0xabc')).toBe('0xabc');
  });

  test('truncates standard 66-char tx hashes', () => {
    const hash = '0x' + 'a'.repeat(64);
    const short = shortTxHash(hash);
    expect(short).toContain('...');
    expect(short.length).toBeLessThan(hash.length);
  });
});
