import { createHash } from 'node:crypto';

import type { LanguageModel } from 'ai';

import type { ModelRole } from '../config/types.js';
import { MPP_KEY_PATTERN, resolveMppMaxDeposit, resolveMppRpcUrl } from '../util/mpp.js';
import {
  challengeChainId,
  challengeRecipient,
  challengeUsdAmount,
  type MppChallengeLike,
} from '../util/mpp-challenge.js';
import { resolveSecret } from '../util/secrets.js';
import {
  createDefaultSpendPolicy,
  enforceSpendPolicy,
  normalizeSpendPolicy,
} from '../wallet/policy.js';

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
  const value = resolveSecret(env, key);
  if (value) return value;
  throw new Error(`Missing ${key}. ${hint}`);
};

const mppInitCache = new Map<string, Promise<void>>();

const MPP_DEFAULT_MAX_DEPOSIT = '0.01';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const mppSpendLedger = new Map<
  string,
  {
    windowStartedAtMs: number;
    spentUsd: number;
  }
>();

const parsePositiveUsdLimit = (
  value: string | undefined,
  fallback: number,
  label: string,
): number => {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: expected a positive number`);
  }
  return parsed;
};

const parseAllowedChainIds = (value: string | undefined): Set<number> | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const out = new Set<number>();
  for (const part of trimmed.split(',')) {
    const raw = part.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error('Invalid OPENHOMIE_MPP_ALLOWED_CHAIN_IDS: expected comma-separated integers');
    }
    out.add(n);
  }
  return out.size ? out : undefined;
};

export const ensureMppClient = async (
  env: NodeJS.ProcessEnv & {
    MPP_PRIVATE_KEY?: string | undefined;
    MPP_MAX_DEPOSIT?: string | undefined;
    MPP_RPC_URL?: string | undefined;
    OPENHOMIE_MPP_MAX_PER_REQUEST_USD?: string | undefined;
    OPENHOMIE_MPP_MAX_PER_DAY_USD?: string | undefined;
    OPENHOMIE_MPP_ALLOWED_CHAIN_IDS?: string | undefined;
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
  const maxPerRequestUsd = parsePositiveUsdLimit(
    env.OPENHOMIE_MPP_MAX_PER_REQUEST_USD,
    0.25,
    'OPENHOMIE_MPP_MAX_PER_REQUEST_USD',
  );
  const maxPerDayUsd = parsePositiveUsdLimit(
    env.OPENHOMIE_MPP_MAX_PER_DAY_USD,
    1,
    'OPENHOMIE_MPP_MAX_PER_DAY_USD',
  );
  const allowedChains = parseAllowedChainIds(env.OPENHOMIE_MPP_ALLOWED_CHAIN_IDS);
  const cacheKey = createHash('sha256')
    .update(privateKey)
    .update('|')
    .update(String(maxDeposit))
    .update('|')
    .update(rpcUrl)
    .update('|')
    .update(String(maxPerRequestUsd))
    .update('|')
    .update(String(maxPerDayUsd))
    .update('|')
    .update(env.OPENHOMIE_MPP_ALLOWED_CHAIN_IDS?.trim() ?? '')
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
      const walletAddress = account.address.toLowerCase();
      const tempoChain = viemChains.tempo;
      const policyBase = createDefaultSpendPolicy({
        chainId: tempoChain.id,
        maxPerRequestUsd,
        maxPerDayUsd,
      });
      const policy = normalizeSpendPolicy({
        ...policyBase,
        allowedChains: allowedChains ?? policyBase.allowedChains,
      });
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
        onChallenge: async (challenge, helpers) => {
          const parsed = challenge as MppChallengeLike;
          const usdAmount = challengeUsdAmount(parsed);
          const chainId = challengeChainId(parsed);
          if (usdAmount === undefined || !Number.isFinite(usdAmount) || usdAmount <= 0) {
            throw new Error('mpp_policy_denied:invalid_amount');
          }
          if (chainId === undefined) {
            throw new Error('mpp_policy_denied:missing_chain_id');
          }
          const now = Date.now();
          const existing = mppSpendLedger.get(walletAddress);
          const window =
            existing && now - existing.windowStartedAtMs <= ONE_DAY_MS
              ? existing
              : { windowStartedAtMs: now, spentUsd: 0 };
          const decision = enforceSpendPolicy(
            {
              usdAmount,
              chainId,
              recipient: challengeRecipient(parsed),
              timestampMs: now,
              purpose: 'mpp_challenge',
            },
            policy,
            window.spentUsd,
          );
          if (!decision.allowed) {
            throw new Error(`mpp_policy_denied:${decision.reason} chainId=${String(chainId)}`);
          }
          const credential = await helpers.createCredential({ account });
          window.spentUsd += usdAmount;
          mppSpendLedger.set(walletAddress, window);
          return credential;
        },
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
