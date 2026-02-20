export { formatCount, formatUsd, shortAddress, shortTxHash } from '../../util/format.js';

import type { PaymentState, UsageSummary } from './types.js';

export const TEMPO_EXPLORER_BASE_URL = 'https://explore.tempo.xyz';
export const MPP_FUNDING_URL = 'https://docs.tempo.xyz/guide/use-accounts/add-funds';
export const TEMPO_CHAIN_LABEL = 'Tempo Testnet (Moderato)';

export const EMPTY_USAGE: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
};

export const addUsage = (left: UsageSummary, right: UsageSummary): UsageSummary => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  costUsd: left.costUsd + right.costUsd,
});

export const paymentStateLabel = (state: PaymentState): string => {
  if (state === 'ready') return 'ready';
  if (state === 'pending') return 'pending';
  if (state === 'success') return 'confirmed';
  if (state === 'failed') return 'failed';
  if (state === 'insufficient_funds') return 'insufficient funds';
  if (state === 'wrong_network') return 'wrong network';
  if (state === 'timeout') return 'timeout';
  if (state === 'endpoint_unreachable') return 'endpoint unreachable';
  if (state === 'invalid_key_format') return 'invalid key';
  if (state === 'cancelled') return 'cancelled';
  return 'unknown';
};

export const classifyPaymentState = (message: string): PaymentState => {
  const low = message.toLowerCase();
  if (
    low.includes('insufficient') ||
    low.includes('payment required') ||
    low.includes('402') ||
    low.includes('balance')
  ) {
    return 'insufficient_funds';
  }
  if (
    low.includes('wrong network') ||
    low.includes('chain') ||
    low.includes('4901') ||
    low.includes('switch network')
  ) {
    return 'wrong_network';
  }
  if (low.includes('invalid') && low.includes('key')) {
    return 'invalid_key_format';
  }
  if (low.includes('timeout') || low.includes('timed out') || low.includes('aborted')) {
    return 'timeout';
  }
  if (
    low.includes('cancelled') ||
    low.includes('canceled') ||
    low.includes('rejected') ||
    low.includes('denied') ||
    low.includes('4001') ||
    low.includes('interrupted')
  ) {
    return 'cancelled';
  }
  if (
    low.includes('unreachable') ||
    low.includes('network') ||
    low.includes('econn') ||
    low.includes('fetch failed')
  ) {
    return 'endpoint_unreachable';
  }
  if (low.includes('failed') || low.includes('error')) return 'failed';
  return 'unknown';
};
