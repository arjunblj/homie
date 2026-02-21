import path from 'node:path';

import { formatCount, formatUsd, shortAddress, shortTxHash } from '../../util/format.js';
import { mapPaymentFailureKind } from '../../wallet/errors.js';
import { icons } from './theme.js';
import type {
  ChatAttachmentRef,
  ChatMessage,
  ChatTurnInput,
  PaymentState,
  TurnUsageSummary,
  UsageSummary,
  VerbosityMode,
} from './types.js';

export { formatCount, formatUsd, shortAddress, shortTxHash };

export const TEMPO_EXPLORER_BASE_URL = 'https://explore.tempo.xyz';
export const MPP_FUNDING_URL = 'https://docs.tempo.xyz/guide/use-accounts/add-funds';
export const TEMPO_CHAIN_LABEL = 'Tempo Testnet (Moderato)';

export const MAX_COMMITTED_MESSAGES = 500;
export const STREAM_FLUSH_DEBOUNCE_MS = 60;

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
  const kind = mapPaymentFailureKind(message);
  if (kind === 'insufficient_funds') return 'insufficient_funds';
  if (kind === 'wrong_network') return 'wrong_network';
  if (kind === 'timeout') return 'timeout';
  if (kind === 'endpoint_unreachable') return 'endpoint_unreachable';
  if (kind === 'invalid_key_format') return 'invalid_key_format';
  if (kind === 'cancelled') return 'cancelled';
  if (kind === 'policy_rejected') return 'failed';

  const low = message.toLowerCase();
  if (low.includes('unreachable')) return 'endpoint_unreachable';
  if (low.includes('failed') || low.includes('error')) return 'failed';
  return 'unknown';
};

export const createMessage = (
  role: ChatMessage['role'],
  content: string,
  isStreaming: boolean,
  opts?: { kind?: ChatMessage['kind'] | undefined },
): ChatMessage => ({
  id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  role,
  content,
  isStreaming,
  timestampMs: Date.now(),
  ...(opts?.kind ? { kind: opts.kind } : {}),
});

const CARD_CHARS =
  icons.toolDone === '✓'
    ? {
        horizontal: '─',
        vertical: '│',
        topLeft: '┌',
        topRight: '┐',
        bottomLeft: '└',
        bottomRight: '┘',
      }
    : {
        horizontal: '-',
        vertical: '|',
        topLeft: '+',
        topRight: '+',
        bottomLeft: '+',
        bottomRight: '+',
      };

const padRight = (value: string, width: number): string =>
  value + ' '.repeat(Math.max(0, width - value.length));

export const renderCard = (title: string, rows: readonly string[]): string => {
  const cols = process.stdout.columns ?? 100;
  const maxInnerWidth = Math.max(24, Math.min(120, cols - 6));
  const clip = (value: string): string =>
    value.length <= maxInnerWidth
      ? value
      : `${value.slice(0, Math.max(0, maxInnerWidth - 3)).trimEnd()}...`;
  const clippedTitle = clip(title);
  const clippedRows = rows.map(clip);
  const innerWidth = Math.max(24, clippedTitle.length + 2, ...clippedRows.map((row) => row.length));
  const top = `${CARD_CHARS.topLeft}${CARD_CHARS.horizontal} ${padRight(clippedTitle, innerWidth)} ${CARD_CHARS.topRight}`;
  const body = rows.map(
    (_, index) =>
      `${CARD_CHARS.vertical} ${padRight(clippedRows[index] ?? '', innerWidth)} ${CARD_CHARS.vertical}`,
  );
  const bottom = `${CARD_CHARS.bottomLeft}${CARD_CHARS.horizontal.repeat(innerWidth + 2)}${CARD_CHARS.bottomRight}`;
  return [top, ...body, bottom].join('\n');
};

const formatField = (label: string, value: string): string => `${label.padEnd(10)} ${value}`;

export const formatTurnReceiptCard = (
  summary: TurnUsageSummary,
  verbosity: VerbosityMode,
  state: PaymentState,
  paymentWalletAddress?: string | undefined,
): string => {
  const usage = summary.usage;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const compactRows = [
    formatField(
      'status',
      `${state === 'success' ? icons.toolDone : state === 'pending' ? icons.thinking : icons.toolError} ${paymentStateLabel(state)}`,
    ),
    formatField(
      'tokens',
      `in ${formatCount(usage.inputTokens)} ${icons.dot} out ${formatCount(usage.outputTokens)} ${icons.dot} total ${formatCount(totalTokens)}`,
    ),
    formatField('cost', usage.costUsd > 0 ? formatUsd(usage.costUsd) : 'unavailable'),
    ...(paymentWalletAddress ? [formatField('wallet', shortAddress(paymentWalletAddress))] : []),
    ...(summary.txHash
      ? [
          formatField(
            'tx',
            `${shortTxHash(summary.txHash)} (${TEMPO_EXPLORER_BASE_URL}/tx/${summary.txHash})`,
          ),
        ]
      : []),
    formatField('explorer', TEMPO_EXPLORER_BASE_URL),
  ];
  if (verbosity === 'compact') return renderCard('payment receipt', compactRows);

  const verboseRows = [
    ...compactRows,
    ...(summary.modelId
      ? [formatField('model', summary.modelId)]
      : [formatField('model', 'unknown')]),
    formatField('llm calls', formatCount(summary.llmCalls)),
    ...(usage.cacheReadTokens > 0
      ? [formatField('cache read', formatCount(usage.cacheReadTokens))]
      : []),
    ...(usage.cacheWriteTokens > 0
      ? [formatField('cache write', formatCount(usage.cacheWriteTokens))]
      : []),
    ...(usage.reasoningTokens > 0
      ? [formatField('reasoning', formatCount(usage.reasoningTokens))]
      : []),
    ...(paymentWalletAddress
      ? [formatField('account', `${TEMPO_EXPLORER_BASE_URL}/address/${paymentWalletAddress}`)]
      : []),
    ...(summary.txHash
      ? [formatField('receipt', `${TEMPO_EXPLORER_BASE_URL}/receipt/${summary.txHash}`)]
      : []),
  ];
  return renderCard('payment receipt', verboseRows);
};

export const COMMANDS: ReadonlyArray<{ cmd: string; desc: string }> = [
  { cmd: '/help', desc: 'show this help' },
  { cmd: '/clear', desc: 'start fresh' },
  { cmd: '/attach', desc: 'send a file with optional note' },
  { cmd: '/retry', desc: 'try the last message again' },
  { cmd: '/wallet', desc: 'wallet status + links' },
  { cmd: '/cost', desc: 'session usage and spend' },
  { cmd: '/verbose', desc: 'show more detail' },
  { cmd: '/compact', desc: 'keep it simple' },
  { cmd: '/status', desc: "what's going on" },
  { cmd: '/exit', desc: 'done for now' },
];

export const summarizeUnknown = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
};

export const logInkError = (scope: string, error: unknown): void => {
  const kind = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`[homie] ${scope} kind=${kind}\n`);
};

export const commandMatches = (input: string): ReadonlyArray<{ cmd: string; desc: string }> => {
  const raw = input.trim().toLowerCase();
  if (!raw.startsWith('/')) return [];
  return COMMANDS.filter((c) => c.cmd.startsWith(raw));
};

export const parseAttachArgs = (
  rawInput: string,
): { attachment: ChatAttachmentRef; text: string } | { error: string } => {
  const rest = rawInput.trim().slice('/attach'.length).trim();
  if (!rest) return { error: 'usage: /attach <path> [message]' };

  const first = rest[0];
  if (first === '"' || first === "'") {
    const quote = first;
    const endIdx = rest.indexOf(quote, 1);
    if (endIdx <= 1) return { error: 'usage: /attach <path> [message]' };
    const filePath = rest.slice(1, endIdx).trim();
    const trailing = rest.slice(endIdx + 1).trim();
    if (!filePath) return { error: 'usage: /attach <path> [message]' };
    return {
      attachment: { path: filePath, displayName: path.basename(filePath) },
      text: trailing,
    };
  }

  const [filePath, ...messageParts] = rest.split(/\s+/u);
  if (!filePath) return { error: 'usage: /attach <path> [message]' };
  return {
    attachment: { path: filePath, displayName: path.basename(filePath) },
    text: messageParts.join(' ').trim(),
  };
};

export const formatUserInputMessage = (input: ChatTurnInput): string => {
  const lines: string[] = [];
  const text = input.text.trim();
  if (text) lines.push(text);
  for (const attachment of input.attachments ?? []) {
    lines.push(`${icons.attachment} ${attachment.displayName}`);
  }
  if (lines.length === 0) lines.push('[empty]');
  return lines.join('\n');
};
