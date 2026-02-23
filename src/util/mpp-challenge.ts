export interface MppChallengeRequest {
  readonly amount?: unknown;
  readonly decimals?: unknown;
  readonly chainId?: unknown;
  readonly methodDetails?: {
    readonly chainId?: unknown;
  };
  readonly recipient?: unknown;
}

export interface MppChallengeLike {
  readonly request?: MppChallengeRequest | undefined;
}

const parseUnsignedBigInt = (value: unknown): bigint | undefined => {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
    return BigInt(value);
  }
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  try {
    return BigInt(raw);
  } catch (_err) {
    return undefined;
  }
};

const parseBoundedInteger = (
  value: unknown,
  options: { min: number; max: number },
): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
  if (parsed < options.min || parsed > options.max) return undefined;
  return parsed;
};

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const toSafeUsdAmount = (amountMinor: bigint, decimals: number): number | undefined => {
  if (decimals === 0) {
    if (amountMinor > MAX_SAFE_INTEGER_BIGINT) return undefined;
    const exact = Number(amountMinor);
    return Number.isFinite(exact) ? exact : undefined;
  }
  const scale = 10n ** BigInt(decimals);
  const whole = amountMinor / scale;
  if (whole > MAX_SAFE_INTEGER_BIGINT) return undefined;
  const fraction = amountMinor % scale;
  const wholeNumber = Number(whole);
  if (!Number.isFinite(wholeNumber)) return undefined;
  const fractionDigits = fraction
    .toString()
    .padStart(decimals, '0')
    .slice(0, 12)
    .replace(/0+$/u, '');
  const fractionNumber = fractionDigits ? Number(`0.${fractionDigits}`) : 0;
  const total = wholeNumber + fractionNumber;
  return Number.isFinite(total) ? total : undefined;
};

export const challengeUsdAmount = (challenge: MppChallengeLike): number | undefined => {
  const request = challenge.request;
  if (!request) return undefined;
  const amountMinor = parseUnsignedBigInt(request.amount);
  // MPP proxy challenges can omit `decimals` (commonly 6 for USD stablecoins).
  const decimals = parseBoundedInteger(request.decimals, { min: 0, max: 30 }) ?? 6;
  if (amountMinor === undefined) return undefined;
  return toSafeUsdAmount(amountMinor, decimals);
};

export const challengeChainId = (challenge: MppChallengeLike): number | undefined => {
  const request = challenge.request;
  if (!request) return undefined;
  const chainRaw = request.chainId ?? request.methodDetails?.chainId;
  return parseBoundedInteger(chainRaw, { min: 1, max: Number.MAX_SAFE_INTEGER });
};

export const challengeRecipient = (challenge: MppChallengeLike): `0x${string}` | undefined => {
  const recipient = challenge.request?.recipient;
  if (typeof recipient !== 'string') return undefined;
  const trimmed = recipient.trim();
  if (!/^0x[a-fA-F0-9]{40}$/u.test(trimmed)) return undefined;
  return trimmed.toLowerCase() as `0x${string}`;
};
