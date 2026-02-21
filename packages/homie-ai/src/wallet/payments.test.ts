import { describe, expect, test } from 'bun:test';
import type { Address } from 'viem';

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

  test('accepts custom rpcUrl option', () => {
    const wallet = generateAgentRuntimeWallet();
    const client = createPaymentSessionClient({
      wallet,
      rpcUrl: 'https://rpc.mainnet.tempo.xyz',
    });
    expect(client.getConnectionState()).toBe('connected');
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

  test('fails closed when challenge decimals are missing', () => {
    const policy = createDefaultSpendPolicy({ maxPerRequestUsd: 1, maxPerDayUsd: 5 });
    const decision = evaluateChallengePolicy(
      {
        request: {
          amount: '1000000',
          chainId: 42431,
        },
      },
      policy,
      0,
    );
    expect(decision).toEqual({ allowed: false, reason: 'invalid_amount' });
  });

  test('fails closed when challenge chainId is missing', () => {
    const policy = createDefaultSpendPolicy({ maxPerRequestUsd: 1, maxPerDayUsd: 5 });
    const decision = evaluateChallengePolicy(
      {
        request: {
          amount: '1000000',
          decimals: 6,
        },
      },
      policy,
      0,
    );
    expect(decision).toEqual({ allowed: false, reason: 'chain_not_allowed' });
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

  test('supports fail-closed defaults by rejecting spend when limits are zero', () => {
    const failClosed = createDefaultSpendPolicy({ maxPerRequestUsd: 0, maxPerDayUsd: 0 });
    const decision = evaluateChallengePolicy(
      {
        request: {
          amount: '1',
          decimals: 0,
          chainId: 42431,
        },
      },
      failClosed,
      0,
    );
    expect(decision).toEqual({ allowed: false, reason: 'per_request_cap_exceeded' });
  });

  test('rejects invalid recipient format when recipient allowlist is active', () => {
    const allowedRecipient = '0x1000000000000000000000000000000000000000' as Address;
    const policy = {
      ...createDefaultSpendPolicy({ maxPerRequestUsd: 2, maxPerDayUsd: 10 }),
      allowedRecipients: new Set<Address>([allowedRecipient]),
    };
    const decision = evaluateChallengePolicy(
      {
        request: {
          amount: '1000000',
          decimals: 6,
          chainId: 42431,
          recipient: 'not-an-address',
        },
      },
      policy,
      0,
    );
    expect(decision).toEqual({ allowed: false, reason: 'recipient_not_allowed' });
  });
});
