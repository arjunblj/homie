import { describe, expect, test } from 'bun:test';

import { createPaymentSessionClient, evaluateChallengePolicy } from './payments.js';
import { createDefaultSpendPolicy } from './policy.js';
import { generateAgentRuntimeWallet } from './runtime.js';

describe('wallet/payments', () => {
  test('initializes with connected lifecycle and can restore', () => {
    const wallet = generateAgentRuntimeWallet();
    const client = createPaymentSessionClient({ wallet });
    expect(client.getConnectionState()).toBe('connected');
    client.restore();
    expect(client.getConnectionState()).toBe('disconnected');
  });

  test('fails closed when challenge amount cannot be parsed', () => {
    const policy = createDefaultSpendPolicy({ maxPerRequestUsd: 1, maxPerDayUsd: 5 });
    const decision = evaluateChallengePolicy(
      {
        request: {
          amount: 'not-a-number',
          decimals: 6,
          chainId: 42431,
        },
      },
      policy,
      0,
    );
    expect(decision).toEqual({ allowed: false, reason: 'invalid_amount' });
  });

  test('enforces caps for parseable challenge amounts', () => {
    const policy = createDefaultSpendPolicy({ maxPerRequestUsd: 1, maxPerDayUsd: 5 });
    const decision = evaluateChallengePolicy(
      {
        request: {
          amount: '2000000',
          decimals: 6,
          chainId: 42431,
        },
      },
      policy,
      0,
    );
    expect(decision).toEqual({ allowed: false, reason: 'per_request_cap_exceeded' });
  });
});
