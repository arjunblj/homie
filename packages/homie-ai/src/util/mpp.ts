import { privateKeyToAccount } from 'viem/accounts';

export const MPP_KEY_PATTERN: RegExp = /^0x[a-fA-F0-9]{64}$/u;

export const normalizeHttpUrl = (value: string): string => {
  const raw = value.trim().replace(/\/+$/u, '');
  if (!raw) return '';
  const withProtocol = /^https?:\/\//iu.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().replace(/\/+$/u, '');
  } catch (_err) {
    return '';
  }
};

export const normalizeMppPrivateKey = (value: string | undefined): `0x${string}` | undefined => {
  const key = value?.trim();
  if (!key || !MPP_KEY_PATTERN.test(key)) return undefined;
  return key as `0x${string}`;
};

const stripOuterQuotes = (value: string): string => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

export const resolveMppRpcUrl = (
  env: NodeJS.ProcessEnv & {
    MPP_RPC_URL?: string | undefined;
    MPPX_RPC_URL?: string | undefined;
    ETH_RPC_URL?: string | undefined;
  },
): string | undefined => {
  const raw =
    env.MPP_RPC_URL?.trim() || env.MPPX_RPC_URL?.trim() || env.ETH_RPC_URL?.trim() || undefined;
  if (!raw) return undefined;
  const normalized = stripOuterQuotes(raw);
  return normalized || undefined;
};

export const resolveMppMaxDeposit = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Invalid MPP_MAX_DEPOSIT: expected a positive number');
  }
  return String(parsed);
};

export const deriveMppWalletAddress = (value: string | undefined): string | undefined => {
  const key = normalizeMppPrivateKey(value);
  if (!key) return undefined;
  return privateKeyToAccount(key).address;
};
