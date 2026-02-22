import { createHash } from 'node:crypto';

import type { LanguageModel } from 'ai';

import type { ModelRole } from '../config/types.js';
import { MPP_KEY_PATTERN, resolveMppMaxDeposit, resolveMppRpcUrl } from '../util/mpp.js';

export interface ResolvedModel {
  role: ModelRole;
  id: string;
  model: LanguageModel;
  providerOptions?: Record<string, unknown> | undefined;
}

export const isProbablyOllama = (baseUrl: string): boolean => {
  const u = baseUrl.toLowerCase();
  return u.includes('localhost:11434') || u.includes('127.0.0.1:11434');
};

export const isProbablyOpenRouter = (baseUrl: string): boolean => {
  return baseUrl.toLowerCase().includes('openrouter.ai');
};

export const isProbablyOpenAi = (baseUrl: string): boolean => {
  return baseUrl.toLowerCase().includes('api.openai.com');
};

export const requireEnv = (env: NodeJS.ProcessEnv, key: string, hint: string): string => {
  const value = env[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing ${key}. ${hint}`);
};

const mppInitCache = new Map<string, Promise<void>>();

const MPP_DEFAULT_MAX_DEPOSIT = '10';

export const ensureMppClient = async (
  env: NodeJS.ProcessEnv & {
    MPP_PRIVATE_KEY?: string | undefined;
    MPP_MAX_DEPOSIT?: string | undefined;
    MPP_RPC_URL?: string | undefined;
  },
): Promise<void> => {
  const privateKey = requireEnv(
    env,
    'MPP_PRIVATE_KEY',
    'MPP provider requires a funded wallet private key.',
  );
  if (!MPP_KEY_PATTERN.test(privateKey)) {
    throw new Error('Invalid MPP_PRIVATE_KEY: expected 0x-prefixed 64-byte hex string');
  }
  const maxDeposit = resolveMppMaxDeposit(env.MPP_MAX_DEPOSIT, MPP_DEFAULT_MAX_DEPOSIT);
  const rpcUrl = resolveMppRpcUrl(env);
  if (!rpcUrl) {
    throw new Error('Missing MPP_RPC_URL. MPP provider requires a Tempo RPC endpoint.');
  }
  const lowerRpcUrl = rpcUrl.toLowerCase();
  if (lowerRpcUrl.includes('base.org') || lowerRpcUrl.includes('mainnet.base')) {
    throw new Error(
      `Invalid MPP_RPC_URL (${rpcUrl}). Use a Tempo RPC endpoint, not a Base RPC endpoint.`,
    );
  }
  const cacheKey = createHash('sha256')
    .update(privateKey)
    .update('|')
    .update(String(maxDeposit))
    .update('|')
    .update(rpcUrl)
    .digest('hex');
  const cached = mppInitCache.get(cacheKey);
  if (cached) return cached;
  const promise = Promise.all([
    import('mppx/client'),
    import('viem'),
    import('viem/accounts'),
    import('viem/chains'),
  ])
    .then(([mppxClient, viem, viemAccounts, viemChains]) => {
      const account = viemAccounts.privateKeyToAccount(privateKey as `0x${string}`);
      const tempoChain = viemChains.tempo;
      mppxClient.Mppx.create({
        methods: [
          mppxClient.tempo({
            account,
            maxDeposit,
            getClient: ({ chainId }: { chainId?: number | undefined }) =>
              viem.createClient({
                chain: { ...tempoChain, id: chainId ?? tempoChain.id },
                transport: viem.http(rpcUrl),
              }),
          }),
        ],
      });
    })
    .catch((err) => {
      mppInitCache.delete(cacheKey);
      if (err instanceof Error && /cannot find module|cannot find package/iu.test(err.message)) {
        throw new Error('MPP provider requires the mppx and viem packages. Run: bun add mppx viem');
      }
      throw err;
    });
  mppInitCache.set(cacheKey, promise);
  return promise;
};

export const isAbortLikeError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /aborted|aborterror/iu.test(err.message);
};
