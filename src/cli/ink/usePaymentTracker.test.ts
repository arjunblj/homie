import { describe, expect, test } from 'bun:test';

import { nextPaymentDetail } from './usePaymentTracker.js';

describe('nextPaymentDetail', () => {
  test('returns provided detail when present', () => {
    expect(nextPaymentDetail('payment confirmed')).toBe('payment confirmed');
  });

  test('clears detail when update has no detail', () => {
    expect(nextPaymentDetail(undefined)).toBe('');
  });
});
