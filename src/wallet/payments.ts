import { Mppx, tempo as mppTempo } from 'mppx/client';
import { type Address, createClient, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';

import {
  challengeChainId,
  challengeUsdAmount,
  type MppChallengeLike,
} from '../util/mpp-challenge.js';
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

const challengeRecipientAddress = (challenge: MppChallengeLike): Address | undefined => {
  const recipient = challenge.request?.recipient;
  if (typeof recipient !== 'string' || !isAddress(recipient)) return undefined;
  return recipient.toLowerCase() as Address;
};

export const evaluateChallengePolicy = (
  challenge: MppChallengeLike,
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
  if (!Number.isFinite(spentLast24hUsd) || spentLast24hUsd < 0) {
    return { allowed: false, reason: 'daily_cap_exceeded' };
  }
  return enforceSpendPolicy(
    {
      usdAmount,
      chainId,
      recipient: challengeRecipientAddress(challenge),
      timestampMs: Date.now(),
      purpose: 'mpp_challenge',
    },
    policy,
    spentLast24hUsd,
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

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  // If the caller doesn't supply a 24h spend callback, enforce a best-effort cap in-memory.
  // This does NOT persist across restarts; it's primarily a safety belt for session-like usage
  // (e.g., `homie deploy`) where multiple paid requests can happen back-to-back.
  let spendWindowStartedAtMs = Date.now();
  let spentWindowUsd = 0;
  const readSpentLast24hUsd = (): number => {
    if (options.spentLast24hUsd) return options.spentLast24hUsd();
    const now = Date.now();
    if (now - spendWindowStartedAtMs > ONE_DAY_MS) {
      spendWindowStartedAtMs = now;
      spentWindowUsd = 0;
    }
    return spentWindowUsd;
  };
  const recordApprovedSpend = (usdAmount: number): void => {
    if (options.spentLast24hUsd) return;
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) return;
    const now = Date.now();
    if (now - spendWindowStartedAtMs > ONE_DAY_MS) {
      spendWindowStartedAtMs = now;
      spentWindowUsd = 0;
    }
    spentWindowUsd += usdAmount;
  };

  const mppx = Mppx.create({
    polyfill: false,
    methods: [
      mppTempo({
        account,
        maxDeposit: options.maxDeposit ?? '0.01',
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
      const usdAmount = challengeUsdAmount(challenge);
      let spentLast24hUsd = 0;
      try {
        spentLast24hUsd = readSpentLast24hUsd();
      } catch (_err) {
        const error = new Error('wallet_policy:spent_tracker_error');
        const kind = mapPaymentFailureKind(error);
        connectionState = 'disconnected';
        lastFailure = kind;
        emitAudit(
          createWalletAuditEvent('payment_failure', {
            walletAddress: options.wallet.address,
            reasonCode: 'spent_tracker_error',
          }),
        );
        throw error;
      }
      const decision = evaluateChallengePolicy(challenge, policy, spentLast24hUsd);
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
      try {
        const credential = await helpers.createCredential({ account });
        if (usdAmount !== undefined) {
          recordApprovedSpend(usdAmount);
        }
        connectionState = 'connected';
        lastFailure = undefined;
        return credential;
      } catch (error) {
        const kind = mapPaymentFailureKind(error);
        connectionState =
          kind === 'timeout' || kind === 'endpoint_unreachable' ? 'reconnecting' : 'disconnected';
        lastFailure = kind;
        emitAudit(
          createWalletAuditEvent('payment_failure', {
            walletAddress: options.wallet.address,
            reasonCode: kind,
          }),
        );
        throw error;
      }
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
