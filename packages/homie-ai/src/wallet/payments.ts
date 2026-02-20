import { Mppx, tempo } from 'mppx/client';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createWalletAuditEvent, redactWalletAuditEvent } from './audit.js';
import { describePaymentFailure, mapPaymentFailureKind } from './errors.js';
import { enforceSpendPolicy } from './policy.js';
import type {
  AgentRuntimeWallet,
  PaymentFailureKind,
  SpendPolicy,
  WalletAuditEvent,
  WalletConnectionLifecycle,
} from './types.js';

interface ChallengeLike {
  readonly request?: Record<string, unknown> | undefined;
}

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
  readonly policy?: SpendPolicy | undefined;
  readonly spentLast24hUsd?: (() => number) | undefined;
  readonly onAuditEvent?: ((event: WalletAuditEvent) => void) | undefined;
}

const challengeUsdAmount = (challenge: ChallengeLike): number | undefined => {
  const request = challenge.request;
  if (!request) return undefined;
  const amountRaw = request['amount'];
  const decimalsRaw = request['decimals'];
  const amount = typeof amountRaw === 'string' ? Number(amountRaw) : Number(amountRaw);
  const decimals = typeof decimalsRaw === 'number' ? decimalsRaw : Number(decimalsRaw ?? 6);
  if (!Number.isFinite(amount) || !Number.isFinite(decimals)) return undefined;
  if (decimals < 0 || decimals > 30) return undefined;
  return amount / 10 ** decimals;
};

const challengeChainId = (challenge: ChallengeLike): number => {
  const chainRaw = challenge.request?.['chainId'];
  const parsed = Number(chainRaw ?? 42431);
  return Number.isFinite(parsed) ? parsed : 42431;
};

const challengeRecipient = (challenge: ChallengeLike): Address | undefined => {
  const recipient = challenge.request?.['recipient'];
  if (typeof recipient !== 'string' || !recipient.startsWith('0x')) return undefined;
  return recipient as Address;
};

export const createPaymentSessionClient = (
  options: CreatePaymentSessionClientOptions,
): PaymentSessionClient => {
  const account = privateKeyToAccount(options.wallet.privateKey);
  let connectionState: WalletConnectionLifecycle = 'connected';
  let lastFailure: PaymentFailureKind | undefined;

  const emitAudit = (event: WalletAuditEvent): void => {
    options.onAuditEvent?.(redactWalletAuditEvent(event));
  };

  const mppx = Mppx.create({
    polyfill: false,
    methods: [tempo({ account, maxDeposit: options.maxDeposit ?? '5' })],
    onChallenge: async (challenge, helpers) => {
      connectionState = 'connecting';
      emitAudit(
        createWalletAuditEvent('payment_challenge', {
          walletAddress: options.wallet.address,
          reasonCode: `${challenge.method}:${challenge.intent}`,
        }),
      );
      if (options.policy) {
        const usdAmount = challengeUsdAmount(challenge);
        if (usdAmount !== undefined) {
          const decision = enforceSpendPolicy(
            {
              usdAmount,
              chainId: challengeChainId(challenge),
              recipient: challengeRecipient(challenge),
              timestampMs: Date.now(),
              purpose: 'mpp_challenge',
            },
            options.policy,
            options.spentLast24hUsd?.() ?? 0,
          );
          if (!decision.allowed) {
            const error = new Error(`wallet_policy:${decision.reason}`);
            const kind = mapPaymentFailureKind(error);
            lastFailure = kind;
            emitAudit(
              createWalletAuditEvent('payment_failure', {
                walletAddress: options.wallet.address,
                reasonCode: decision.reason,
              }),
            );
            throw error;
          }
        }
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
