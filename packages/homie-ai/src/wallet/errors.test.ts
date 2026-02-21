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

  test('maps wallet policy failures', () => {
    expect(mapPaymentFailureKind(new Error('wallet_policy:per_request_cap_exceeded'))).toBe(
      'policy_rejected',
    );
  });

  test('returns actionable remediation', () => {
    const failure = describePaymentFailure('wrong_network', 'switch chain');
    expect(failure.remediation.toLowerCase()).toContain('switch');
  });

  test('returns policy remediation guidance', () => {
    const failure = describePaymentFailure('policy_rejected', 'wallet_policy:invalid_amount');
    expect(failure.remediation.toLowerCase()).toContain('policy');
  });

  test('does not misclassify "blockchain" as wrong_network', () => {
    expect(mapPaymentFailureKind(new Error('blockchain sync in progress'))).toBe('unknown');
  });

  test('does not misclassify "neural network" as endpoint_unreachable', () => {
    expect(mapPaymentFailureKind(new Error('neural network inference failed'))).toBe('unknown');
  });

  test('does not misclassify "load balancer" as insufficient_funds', () => {
    expect(mapPaymentFailureKind(new Error('load balancer unreachable'))).toBe('unknown');
  });

  test('classifies chain id errors as wrong_network', () => {
    expect(mapPaymentFailureKind(new Error('wrong chain id'))).toBe('wrong_network');
  });

  test('classifies timeout before network in priority', () => {
    expect(mapPaymentFailureKind(new Error('network timeout'))).toBe('timeout');
  });

  test('classifies rejected signatures as cancelled', () => {
    expect(mapPaymentFailureKind(new Error('User rejected request (4001)'))).toBe('cancelled');
  });
});
