import type { Address } from 'viem';

import type { SpendAttempt, SpendDecision, SpendPolicy } from './types.js';

const normalizeAddress = (value: Address): Address => value.toLowerCase() as Address;

const hasAddress = (set: ReadonlySet<Address>, value: Address | undefined): boolean => {
  if (!value) return false;
  return set.has(normalizeAddress(value));
};

const sanitizeNonNegativeFinite = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
};

export const normalizeSpendPolicy = (policy: SpendPolicy): SpendPolicy => {
  return {
    ...policy,
    allowedRecipients: new Set(
      Array.from(policy.allowedRecipients, (address) => normalizeAddress(address)),
    ),
    allowedContracts: new Set(
      Array.from(policy.allowedContracts, (address) => normalizeAddress(address)),
    ),
  };
};

export const enforceSpendPolicy = (
  input: SpendAttempt,
  policy: SpendPolicy,
  spentLast24hUsd: number,
): SpendDecision => {
  const maxPerRequestUsd = sanitizeNonNegativeFinite(policy.maxPerRequestUsd, 0);
  const maxPerDayUsd = sanitizeNonNegativeFinite(policy.maxPerDayUsd, 0);
  const safeSpentLast24hUsd = sanitizeNonNegativeFinite(spentLast24hUsd, 0);

  if (!Number.isFinite(input.usdAmount) || input.usdAmount <= 0) {
    return { allowed: false, reason: 'invalid_amount' };
  }
  if (input.usdAmount > maxPerRequestUsd) {
    return { allowed: false, reason: 'per_request_cap_exceeded' };
  }
  if (safeSpentLast24hUsd + input.usdAmount > maxPerDayUsd) {
    return { allowed: false, reason: 'daily_cap_exceeded' };
  }
  if (!policy.allowedChains.has(input.chainId)) {
    return { allowed: false, reason: 'chain_not_allowed' };
  }
  if (policy.allowedRecipients.size > 0 && !hasAddress(policy.allowedRecipients, input.recipient)) {
    return { allowed: false, reason: 'recipient_not_allowed' };
  }
  if (policy.allowedContracts.size > 0 && !hasAddress(policy.allowedContracts, input.contract)) {
    return { allowed: false, reason: 'contract_not_allowed' };
  }
  return { allowed: true };
};

export const createDefaultSpendPolicy = (parameters?: {
  chainId?: number | undefined;
  maxPerRequestUsd?: number | undefined;
  maxPerDayUsd?: number | undefined;
}): SpendPolicy => {
  return {
    maxPerRequestUsd: parameters?.maxPerRequestUsd ?? 1,
    maxPerDayUsd: parameters?.maxPerDayUsd ?? 5,
    allowedRecipients: new Set<Address>(),
    allowedContracts: new Set<Address>(),
    allowedChains: new Set<number>([parameters?.chainId ?? 42431]),
  };
};
