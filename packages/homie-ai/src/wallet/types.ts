import type { Address, Hex } from 'viem';

export type WalletNetwork = 'tempo-moderato' | 'tempo-mainnet';

export interface AgentRuntimeWallet {
  readonly address: Address;
  readonly privateKey: Hex;
}

export interface OperatorRootAuthority {
  readonly kind: 'passkey' | 'hardware-wallet' | 'unknown';
  readonly label: string;
  readonly credentialId?: string | undefined;
}

export interface TokenLimit {
  readonly token: Address;
  readonly amount: bigint;
}

export interface SpendPolicy {
  readonly maxPerRequestUsd: number;
  readonly maxPerDayUsd: number;
  readonly allowedRecipients: ReadonlySet<Address>;
  readonly allowedContracts: ReadonlySet<Address>;
  readonly allowedChains: ReadonlySet<number>;
}

export interface WalletCapabilities {
  readonly canSign: boolean;
  readonly canReceive: boolean;
  readonly canSpend: boolean;
  readonly hasKeychainGrant: boolean;
  readonly network: WalletNetwork;
}

export interface KeychainGrant {
  readonly rootAccount: Address;
  readonly keyId: Address;
  readonly expiry: number | undefined;
  readonly limits: readonly TokenLimit[];
}

export type PaymentFailureKind =
  | 'insufficient_funds'
  | 'wrong_network'
  | 'timeout'
  | 'endpoint_unreachable'
  | 'invalid_key_format'
  | 'policy_rejected'
  | 'cancelled'
  | 'unknown';

export type WalletConnectionLifecycle =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected';

export type WalletReadinessState =
  | { kind: 'active'; address: Address; funded: boolean }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string };

export interface SpendAttempt {
  readonly usdAmount: number;
  readonly chainId: number;
  readonly recipient?: Address | undefined;
  readonly contract?: Address | undefined;
  readonly timestampMs: number;
  readonly purpose?: string | undefined;
}

export type SpendDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'per_request_cap_exceeded'
        | 'daily_cap_exceeded'
        | 'recipient_not_allowed'
        | 'contract_not_allowed'
        | 'chain_not_allowed'
        | 'invalid_amount';
    };

export interface WalletAuditEvent {
  readonly event:
    | 'wallet_loaded'
    | 'wallet_generated'
    | 'payment_challenge'
    | 'payment_failure'
    | 'keychain_grant'
    | 'keychain_revoke'
    | 'keychain_limit_update';
  readonly atMs: number;
  readonly walletAddress?: Address | undefined;
  readonly txHash?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
}
