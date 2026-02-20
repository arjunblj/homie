import { describe, expect, test } from 'bun:test';
import { toCliErrorMessage } from './cli.js';

describe('toCliErrorMessage', () => {
  test('returns Error.message for Error instances', () => {
    expect(toCliErrorMessage(new Error('boom'))).toBe('boom');
  });

  test('stringifies unknown values', () => {
    expect(toCliErrorMessage('fail')).toBe('fail');
    expect(toCliErrorMessage(42)).toBe('42');
  });
});
