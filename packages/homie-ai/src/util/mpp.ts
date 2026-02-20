import { privateKeyToAccount } from 'viem/accounts';

export const MPP_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/u;

export const normalizeHttpUrl = (value: string): string => {
  let url = value.trim().replace(/\/+$/u, '');
  if (url && !/^https?:\/\//iu.test(url)) {
    url = `http://${url}`;
  }
  return url;
};

export const normalizeMppPrivateKey = (value: string | undefined): `0x${string}` | undefined => {
  const key = value?.trim();
  if (!key || !MPP_KEY_PATTERN.test(key)) return undefined;
  return key as `0x${string}`;
};

export const deriveMppWalletAddress = (value: string | undefined): string | undefined => {
  const key = normalizeMppPrivateKey(value);
  if (!key) return undefined;
  try {
    return privateKeyToAccount(key).address;
  } catch {
    return undefined;
  }
};
