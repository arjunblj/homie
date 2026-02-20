import { describe, expect, test } from 'bun:test';

import { describePaymentFailure, mapPaymentFailureKind } from './errors.js';

describe('wallet/errors', () => {
  test('maps insufficient funds errors', () => {
    expect(mapPaymentFailureKind(new Error('402 payment required: insufficient balance'))).toBe(
      'insufficient_funds',
    );
  });

  test('maps endpoint failures', () => {
    expect(mapPaymentFailureKind(new Error('fetch failed: ECONNREFUSED'))).toBe(
      'endpoint_unreachable',
    );
  });

  test('returns actionable remediation', () => {
    const failure = describePaymentFailure('wrong_network', 'switch chain');
    expect(failure.remediation.toLowerCase()).toContain('switch');
  });
});
