import type { PaymentFailureKind } from './types.js';

export interface PaymentFailure {
  readonly kind: PaymentFailureKind;
  readonly detail: string;
  readonly remediation: string;
}

export const mapPaymentFailureKind = (error: unknown): PaymentFailureKind => {
  const message = error instanceof Error ? error.message : String(error);
  const low = message.toLowerCase();
  if (!message.trim()) return 'unknown';
  if (low.includes('wallet_policy:')) {
    return 'policy_rejected';
  }
  if (
    low.includes('cancelled') ||
    low.includes('canceled') ||
    low.includes('interrupted') ||
    low.includes('rejected') ||
    low.includes('denied') ||
    low.includes('4001')
  ) {
    return 'cancelled';
  }
  if (low.includes('invalid') && low.includes('key')) {
    return 'invalid_key_format';
  }
  if (
    low.includes('insufficient') ||
    low.includes('payment required') ||
    low.includes('402') ||
    low.includes('insufficient balance') ||
    low.includes('low balance') ||
    low.includes('balance too low')
  ) {
    return 'insufficient_funds';
  }
  if (
    low.includes('wrong network') ||
    low.includes('switch network') ||
    low.includes('chain id') ||
    low.includes('chainid') ||
    low.includes('wrong chain') ||
    low.includes('chain mismatch')
  ) {
    return 'wrong_network';
  }
  if (low.includes('timeout') || low.includes('timed out') || low.includes('aborted')) {
    return 'timeout';
  }
  if (
    low.includes('econnrefused') ||
    low.includes('enotfound') ||
    low.includes('fetch failed') ||
    low.includes('network error') ||
    low.includes('network request') ||
    low.includes('network timeout')
  ) {
    return 'endpoint_unreachable';
  }
  return 'unknown';
};

export const describePaymentFailure = (
  kind: PaymentFailureKind,
  detail: string,
): PaymentFailure => {
  if (kind === 'insufficient_funds') {
    return {
      kind,
      detail,
      remediation: 'Fund the wallet, then retry.',
    };
  }
  if (kind === 'wrong_network') {
    return {
      kind,
      detail,
      remediation: 'Switch to Tempo Moderato and retry.',
    };
  }
  if (kind === 'timeout') {
    return {
      kind,
      detail,
      remediation: 'Retry in a few seconds.',
    };
  }
  if (kind === 'endpoint_unreachable') {
    return {
      kind,
      detail,
      remediation: 'Check endpoint reachability and network access, then retry.',
    };
  }
  if (kind === 'invalid_key_format') {
    return {
      kind,
      detail,
      remediation: 'Replace the key with a valid 0x-prefixed 64-byte hex private key.',
    };
  }
  if (kind === 'policy_rejected') {
    return {
      kind,
      detail,
      remediation: 'Adjust wallet spend policy or lower request cost, then retry.',
    };
  }
  if (kind === 'cancelled') {
    return {
      kind,
      detail,
      remediation: 'No action required. Retry when you are ready.',
    };
  }
  return {
    kind,
    detail,
    remediation: 'Retry. If it persists, run homie doctor for diagnostics.',
  };
};
