import { describe, expect, test } from 'bun:test';
import type { Address } from 'viem';

import { createDefaultSpendPolicy, enforceSpendPolicy } from './policy.js';

describe('wallet/policy', () => {
  test('rejects request above per-request cap', () => {
    const policy = createDefaultSpendPolicy({ maxPerRequestUsd: 0.5, maxPerDayUsd: 5 });
    const decision = enforceSpendPolicy(
      {
        usdAmount: 1,
        chainId: 42431,
        timestampMs: Date.now(),
      },
      policy,
      0,
    );
    expect(decision).toEqual({ allowed: false, reason: 'per_request_cap_exceeded' });
  });

  test('rejects when daily cap exceeded', () => {
    const policy = createDefaultSpendPolicy({ maxPerRequestUsd: 2, maxPerDayUsd: 3 });
    const decision = enforceSpendPolicy(
      {
        usdAmount: 1.5,
        chainId: 42431,
        timestampMs: Date.now(),
      },
      policy,
      2,
    );
    expect(decision).toEqual({ allowed: false, reason: 'daily_cap_exceeded' });
  });

  test('accepts valid spend attempt', () => {
    const policy = createDefaultSpendPolicy({ maxPerRequestUsd: 2, maxPerDayUsd: 5 });
    const decision = enforceSpendPolicy(
      {
        usdAmount: 1,
        chainId: 42431,
        timestampMs: Date.now(),
      },
      policy,
      2,
    );
    expect(decision).toEqual({ allowed: true });
  });

  test('rejects when recipient allowlist is set but recipient is missing', () => {
    const recipient = '0x1000000000000000000000000000000000000000' as Address;
    const policy = {
      ...createDefaultSpendPolicy({ maxPerRequestUsd: 2, maxPerDayUsd: 5 }),
      allowedRecipients: new Set([recipient]),
    };
    const decision = enforceSpendPolicy(
      {
        usdAmount: 1,
        chainId: 42431,
        timestampMs: Date.now(),
      },
      policy,
      0,
    );
    expect(decision).toEqual({ allowed: false, reason: 'recipient_not_allowed' });
  });

  test('rejects when contract allowlist is set but contract is missing', () => {
    const contract = '0x2000000000000000000000000000000000000000' as Address;
    const policy = {
      ...createDefaultSpendPolicy({ maxPerRequestUsd: 2, maxPerDayUsd: 5 }),
      allowedContracts: new Set([contract]),
    };
    const decision = enforceSpendPolicy(
      {
        usdAmount: 1,
        chainId: 42431,
        timestampMs: Date.now(),
      },
      policy,
      0,
    );
    expect(decision).toEqual({ allowed: false, reason: 'contract_not_allowed' });
  });
});
