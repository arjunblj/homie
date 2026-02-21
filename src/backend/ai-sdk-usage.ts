import { errorFields, log } from '../util/logger.js';
import type { LLMUsage } from './types.js';

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

interface UsageRecord extends Record<string, unknown> {
  cost?: unknown;
  totalCost?: unknown;
  costUsd?: unknown;
  usage?: unknown;
  providerMetadata?: unknown;
}

const asRecord = (value: unknown): UsageRecord | null => {
  if (!value || typeof value !== 'object') return null;
  return value as UsageRecord;
};

const extractUsageCostUsd = (usageRaw: unknown): number | undefined => {
  const root = asRecord(usageRaw);
  if (!root) return undefined;

  const candidates: unknown[] = [root.cost, root.totalCost, root.costUsd];
  const usage = asRecord(root.usage);
  if (usage) {
    candidates.push(usage.cost, usage.totalCost, usage.costUsd);
  }

  const providerMetadata = asRecord(root.providerMetadata);
  if (providerMetadata) {
    for (const value of Object.values(providerMetadata)) {
      const providerSlice = asRecord(value);
      if (!providerSlice) continue;
      candidates.push(providerSlice.cost, providerSlice.totalCost, providerSlice.costUsd);
    }
  }

  for (const candidate of candidates) {
    const cost = asFiniteNumber(candidate);
    if (cost !== undefined && cost >= 0) return cost;
  }
  return undefined;
};

const TX_HASH_PATTERN = /\b0x[a-fA-F0-9]{64}\b/u;

const txHashFromString = (value: string): string | undefined => {
  const direct = value.match(TX_HASH_PATTERN)?.[0];
  if (direct) return direct.toLowerCase();

  // Some providers nest payment proof data in base64 payloads.
  if (/^[A-Za-z0-9+/=]{40,}$/u.test(value)) {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const nested = decoded.match(TX_HASH_PATTERN)?.[0];
      if (nested) return nested.toLowerCase();
    } catch (err) {
      log.debug('txHashFromString.base64_decode_failed', errorFields(err));
    }
  }
  return undefined;
};

const extractUsageTxHash = (usageRaw: unknown): string | undefined => {
  const scan = (value: unknown, depth: number): string | undefined => {
    if (depth > 5) return undefined;
    if (typeof value === 'string') return txHashFromString(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = scan(item, depth + 1);
        if (nested) return nested;
      }
      return undefined;
    }
    const rec = asRecord(value);
    if (!rec) return undefined;

    for (const key of ['txHash', 'transactionHash', 'paymentTxHash', 'hash'] as const) {
      const nested = scan(rec[key], depth + 1);
      if (nested) return nested;
    }

    for (const [key, nestedValue] of Object.entries(rec)) {
      if (/hash|tx/iu.test(key)) {
        const nested = scan(nestedValue, depth + 1);
        if (nested) return nested;
      }
    }
    for (const nestedValue of Object.values(rec)) {
      const nested = scan(nestedValue, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  };

  const fromTree = scan(usageRaw, 0);
  if (fromTree) return fromTree;
  try {
    const serialized = JSON.stringify(usageRaw);
    if (!serialized) return undefined;
    return txHashFromString(serialized);
  } catch (err) {
    log.debug('extractUsageTxHash.serialize_failed', errorFields(err));
    return undefined;
  }
};

export const normalizeUsage = (usageRaw: unknown): LLMUsage | undefined => {
  const topLevel = usageRaw as
    | {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        inputTokenDetails?:
          | { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined }
          | undefined;
        outputTokenDetails?: { reasoningTokens?: number | undefined } | undefined;
        usage?:
          | {
              inputTokens?: number | undefined;
              outputTokens?: number | undefined;
              inputTokenDetails?:
                | { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined }
                | undefined;
              outputTokenDetails?: { reasoningTokens?: number | undefined } | undefined;
            }
          | undefined;
      }
    | undefined;
  const usage = topLevel?.usage ?? topLevel;
  if (!usageRaw && !usage) return undefined;
  const costUsd = extractUsageCostUsd(usageRaw);
  const txHash = extractUsageTxHash(usageRaw);
  return {
    inputTokens: usage?.inputTokens ?? undefined,
    outputTokens: usage?.outputTokens ?? undefined,
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? undefined,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? undefined,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? undefined,
    costUsd: costUsd ?? undefined,
    txHash: txHash ?? undefined,
  };
};
