import { Mppx, tempo as mppTempo } from 'mppx/client';
import { type Address, createClient, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';

import { createWalletAuditEvent, redactWalletAuditEvent } from './audit.js';
import { describePaymentFailure, mapPaymentFailureKind } from './errors.js';
import { createDefaultSpendPolicy, enforceSpendPolicy } from './policy.js';
import type {
  AgentRuntimeWallet,
  PaymentFailureKind,
  SpendPolicy,
  WalletAuditEvent,
  WalletConnectionLifecycle,
} from './types.js';

interface ChallengeRequest {
  readonly amount?: unknown;
  readonly decimals?: unknown;
  readonly chainId?: unknown;
  readonly recipient?: unknown;
}

interface ChallengeLike {
  readonly request?: ChallengeRequest | undefined;
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

export interface PaymentSessionClient {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly fetchWithContext: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    context: { account?: Address | `0x${string}` } | undefined,
  ) => Promise<Response>;
  readonly restore: () => void;
  readonly getConnectionState: () => WalletConnectionLifecycle;
  readonly getLastFailure: () => PaymentFailureKind | undefined;
}

export interface CreatePaymentSessionClientOptions {
  readonly wallet: AgentRuntimeWallet;
  readonly maxDeposit?: string | undefined;
  readonly rpcUrl?: string | undefined;
  readonly policy?: SpendPolicy | undefined;
  readonly spentLast24hUsd?: (() => number) | undefined;
  readonly onAuditEvent?: ((event: WalletAuditEvent) => void) | undefined;
}

const challengeUsdAmount = (challenge: ChallengeLike): number | undefined => {
  const request = challenge.request;
  if (!request) return undefined;
  const amountMinor = parseUnsignedBigInt(request.amount);
  const decimals = parseBoundedInteger(request.decimals, { min: 0, max: 30 });
  if (amountMinor === undefined || decimals === undefined) return undefined;
  const amount = Number(amountMinor);
  if (!Number.isFinite(amount)) return undefined;
  return amount / 10 ** decimals;
};

const challengeChainId = (challenge: ChallengeLike): number | undefined => {
  const chainRaw = challenge.request?.chainId;
  return parseBoundedInteger(chainRaw, { min: 1, max: Number.MAX_SAFE_INTEGER });
};

const challengeRecipient = (challenge: ChallengeLike): Address | undefined => {
  const recipient = challenge.request?.recipient;
  if (typeof recipient !== 'string' || !isAddress(recipient)) return undefined;
  return recipient.toLowerCase() as Address;
};

export const evaluateChallengePolicy = (
  challenge: ChallengeLike,
  policy: SpendPolicy,
  spentLast24hUsd: number,
): ReturnType<typeof enforceSpendPolicy> => {
  const usdAmount = challengeUsdAmount(challenge);
  const chainId = challengeChainId(challenge);
  if (usdAmount === undefined) {
    return { allowed: false, reason: 'invalid_amount' };
  }
  if (chainId === undefined) {
    return { allowed: false, reason: 'chain_not_allowed' };
  }
  const safeSpentLast24hUsd =
    Number.isFinite(spentLast24hUsd) && spentLast24hUsd > 0 ? spentLast24hUsd : 0;
  return enforceSpendPolicy(
    {
      usdAmount,
      chainId,
      recipient: challengeRecipient(challenge),
      timestampMs: Date.now(),
      purpose: 'mpp_challenge',
    },
    policy,
    safeSpentLast24hUsd,
  );
};

export const createPaymentSessionClient = (
  options: CreatePaymentSessionClientOptions,
): PaymentSessionClient => {
  const account = privateKeyToAccount(options.wallet.privateKey);
  // Fail-closed default: deny spend unless an explicit policy is provided by the caller.
  const policy =
    options.policy ??
    createDefaultSpendPolicy({
      maxPerRequestUsd: 0,
      maxPerDayUsd: 0,
    });
  let connectionState: WalletConnectionLifecycle = 'connected';
  let lastFailure: PaymentFailureKind | undefined;

  const emitAudit = (event: WalletAuditEvent): void => {
    options.onAuditEvent?.(redactWalletAuditEvent(event));
  };

  const mppx = Mppx.create({
    polyfill: false,
    methods: [
      mppTempo({
        account,
        maxDeposit: options.maxDeposit ?? '5',
        ...(options.rpcUrl
          ? {
              getClient: ({ chainId }: { chainId?: number | undefined }) =>
                createClient({
                  chain: { ...tempo, id: chainId ?? tempo.id },
                  transport: http(options.rpcUrl),
                }),
            }
          : {}),
      }),
    ],
    onChallenge: async (challenge, helpers) => {
      connectionState = 'connecting';
      emitAudit(
        createWalletAuditEvent('payment_challenge', {
          walletAddress: options.wallet.address,
          reasonCode: `${challenge.method}:${challenge.intent}`,
        }),
      );
      // NOTE: 24h spend tracking is caller-supplied for now. Until we persist this centrally
      // (e.g., SQLite-backed usage ledger), the daily cap is only as accurate as the callback.
      const decision = evaluateChallengePolicy(challenge, policy, options.spentLast24hUsd?.() ?? 0);
      if (!decision.allowed) {
        const error = new Error(`wallet_policy:${decision.reason}`);
        const kind = mapPaymentFailureKind(error);
        connectionState = 'disconnected';
        lastFailure = kind;
        emitAudit(
          createWalletAuditEvent('payment_failure', {
            walletAddress: options.wallet.address,
            reasonCode: decision.reason,
          }),
        );
        throw error;
      }
      const credential = await helpers.createCredential({ account });
      connectionState = 'connected';
      return credential;
    },
  });

  const fetchWithContext: PaymentSessionClient['fetchWithContext'] = async (
    input,
    init,
    context,
  ): Promise<Response> => {
    if (connectionState === 'disconnected' || connectionState === 'reconnecting') {
      connectionState = 'connecting';
    }
    try {
      const response = await (
        mppx.fetch as (
          i: RequestInfo | URL,
          j?: RequestInit & { context?: { account?: Address | `0x${string}` } },
        ) => Promise<Response>
      )(input, {
        ...(init ?? {}),
        ...(context ? { context } : {}),
      });
      connectionState = 'connected';
      lastFailure = undefined;
      return response;
    } catch (error) {
      const kind = mapPaymentFailureKind(error);
      lastFailure = kind;
      connectionState =
        kind === 'timeout' || kind === 'endpoint_unreachable' ? 'reconnecting' : 'disconnected';
      const failure = describePaymentFailure(
        kind,
        error instanceof Error ? error.message : String(error),
      );
      emitAudit(
        createWalletAuditEvent('payment_failure', {
          walletAddress: options.wallet.address,
          reasonCode: failure.kind,
          metadata: { remediation: failure.remediation },
        }),
      );
      throw error;
    }
  };

  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return await fetchWithContext(input, init, undefined);
    },
    fetchWithContext,
    restore: (): void => {
      Mppx.restore();
      connectionState = 'disconnected';
    },
    getConnectionState: (): WalletConnectionLifecycle => connectionState,
    getLastFailure: (): PaymentFailureKind | undefined => lastFailure,
  };
};
