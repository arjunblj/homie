import { describe, expect, test } from 'bun:test';
import { classifyPaymentConnectionState, toCliErrorMessage } from './cli.js';

describe('toCliErrorMessage', () => {
  test('returns Error.message for Error instances', () => {
    expect(toCliErrorMessage(new Error('boom'))).toBe('boom');
  });

  test('stringifies unknown values', () => {
    expect(toCliErrorMessage('fail')).toBe('fail');
    expect(toCliErrorMessage(42)).toBe('42');
  });
});

describe('classifyPaymentConnectionState', () => {
  test('marks transport errors as reconnecting', () => {
    expect(classifyPaymentConnectionState('error: fetch failed', 'failed', true)).toBe(
      'reconnecting',
    );
  });

  test('marks invalid request as disconnected', () => {
    expect(
      classifyPaymentConnectionState('error: invalid key format', 'invalid_key_format', true),
    ).toBe('disconnected');
  });

  test('keeps cancelled state connected when wallet exists', () => {
    expect(classifyPaymentConnectionState('cancelled', 'cancelled', true)).toBe('connected');
  });
});
