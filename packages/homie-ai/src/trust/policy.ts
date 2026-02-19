import type { PersonRecord } from '../memory/types.js';
import type { ChatTrustTier } from './types.js';

export const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export const deriveTrustTierFromScore = (score: number): ChatTrustTier => {
  const s = clamp01(score);
  if (s >= 0.65) return 'trusted';
  if (s >= 0.25) return 'warming';
  return 'untrusted';
};

export const deriveTrustTierForPerson = (person: PersonRecord | null): ChatTrustTier => {
  if (!person) return 'untrusted';
  if (person.trustTierOverride) return person.trustTierOverride;
  return deriveTrustTierFromScore(person.relationshipScore);
};
