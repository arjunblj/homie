import path from 'node:path';
import cliCursor from 'cli-cursor';
import { Box, Static, Text, useApp, useInput } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addUsage,
  classifyPaymentState,
  EMPTY_USAGE,
  formatCount,
  formatUsd,
  MPP_FUNDING_URL,
  paymentStateLabel,
  shortAddress,
  shortTxHash,
  TEMPO_CHAIN_LABEL,
  TEMPO_EXPLORER_BASE_URL,
} from './format.js';
import { Message, shouldShowTimestamp, TimestampDivider, TypingIndicator } from './Message.js';
import { StatusBar } from './StatusBar.js';
import { formatBrand, icons, placeholderText } from './theme.js';
import type {
  ChatAttachmentRef,
  ChatMessage,
  ChatPhase,
  ChatTurnInput,
  ChatTurnResult,
  ChatTurnStreamer,
  PaymentState,
  SessionMetrics,
  ToolCallState,
  TurnUsageSummary,
  UsageSummary,
  VerbosityMode,
} from './types.js';

interface AppProps {
  modelLabel: string;
  startTurn: ChatTurnStreamer;
  providerKind: string;
  agentWalletAddress?: string | undefined;
  paymentWalletAddress?: string | undefined;
}

const createMessage = (
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

const renderCard = (title: string, rows: readonly string[]): string => {
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

const formatTurnReceiptCard = (
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

const COMMANDS: ReadonlyArray<{ cmd: string; desc: string }> = [
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

const summarizeUnknown = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const logInkError = (scope: string, error: unknown): void => {
  const kind = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`[homie] ${scope} kind=${kind}\n`);
};

const commandMatches = (input: string): ReadonlyArray<{ cmd: string; desc: string }> => {
  const raw = input.trim().toLowerCase();
  if (!raw.startsWith('/')) return [];
  return COMMANDS.filter((c) => c.cmd.startsWith(raw));
};

const parseAttachArgs = (
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

const formatUserInputMessage = (input: ChatTurnInput): string => {
  const lines: string[] = [];
  const text = input.text.trim();
  if (text) lines.push(text);
  for (const attachment of input.attachments ?? []) {
    lines.push(`${icons.attachment} ${attachment.displayName}`);
  }
  if (lines.length === 0) lines.push('[empty]');
  return lines.join('\n');
};

export function App({
  modelLabel,
  startTurn,
  providerKind,
  agentWalletAddress,
  paymentWalletAddress,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [committedMessages, setCommittedMessages] = useState<ChatMessage[]>([]);
  const [activeMessage, setActiveMessage] = useState<ChatMessage | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<ChatPhase>('idle');
  const [metrics, setMetrics] = useState<SessionMetrics>({ turns: 0, queued: 0 });
  const [sessionUsage, setSessionUsage] = useState<UsageSummary>(EMPTY_USAGE);
  const [sessionLlmCalls, setSessionLlmCalls] = useState(0);
  const [latestPaymentState, setLatestPaymentState] = useState<PaymentState>('ready');
  const [latestPaymentTxHash, setLatestPaymentTxHash] = useState<string | undefined>(undefined);
  const [latestPaymentDetail, setLatestPaymentDetail] = useState('');
  const [verbosity, setVerbosity] = useState<VerbosityMode>('compact');
  const [activeReasoningTrace, setActiveReasoningTrace] = useState('');
  const [turnStartedAtMs, setTurnStartedAtMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pendingEscInterrupt, setPendingEscInterrupt] = useState(false);
  const [lastUserInput, setLastUserInput] = useState<ChatTurnInput | null>(null);
  const [showSilenceHint, setShowSilenceHint] = useState(false);
  const [activeAttachmentCount, setActiveAttachmentCount] = useState(0);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [showTypingDots, setShowTypingDots] = useState(false);
  const inFlightRef = useRef(false);
  const activeCancelRef = useRef<(() => void) | null>(null);
  const pendingQueueRef = useRef<ChatTurnInput[]>([]);
  const lastEscAtMsRef = useRef(0);
  const historyOffsetRef = useRef(0);
  const savedDraftRef = useRef('');
  const lastFlushedLenRef = useRef(0);

  const commitMessage = useCallback((message: ChatMessage): void => {
    setCommittedMessages((prev) => [...prev, message]);
  }, []);

  const syncQueuedCount = useCallback((): void => {
    setMetrics((prev) => ({ ...prev, queued: pendingQueueRef.current.length }));
  }, []);

  const commitMeta = useCallback(
    (content: string, opts?: { force?: boolean }): void => {
      const force = opts?.force ?? false;
      if (!force && verbosity === 'compact') return;
      commitMessage(createMessage('meta', content, false));
    },
    [commitMessage, verbosity],
  );

  const finalizeTurn = useCallback(
    (
      assistantMessageId: string,
      streamedText: string,
      reasoningTrace: string,
      result: ChatTurnResult,
      turnUsage: TurnUsageSummary | null,
      paymentStateForTurn: PaymentState,
    ): void => {
      const maybeCommitReceipt = (): void => {
        if (providerKind !== 'mpp' || !turnUsage || turnUsage.llmCalls <= 0) return;
        const receipt = formatTurnReceiptCard(
          turnUsage,
          verbosity,
          paymentStateForTurn,
          paymentWalletAddress,
        );
        if (!receipt) return;
        commitMessage(createMessage('meta', receipt, false, { kind: 'receipt' }));
      };
      const partial = streamedText.trim();
      if (result.kind === 'send_text') {
        const finalText = (partial || result.text).trim();
        if (finalText) {
          commitMessage({
            id: assistantMessageId,
            role: 'assistant',
            content: finalText,
            isStreaming: false,
            timestampMs: Date.now(),
            ...(reasoningTrace.trim() ? { reasoningTrace: reasoningTrace.trim() } : {}),
          });
        }
        maybeCommitReceipt();
        return;
      }

      if (partial) {
        commitMessage({
          id: assistantMessageId,
          role: 'assistant',
          content: partial,
          isStreaming: false,
          timestampMs: Date.now(),
          ...(reasoningTrace.trim() ? { reasoningTrace: reasoningTrace.trim() } : {}),
        });
      }

      if (result.kind === 'react') {
        commitMessage(createMessage('meta', result.emoji, false));
        maybeCommitReceipt();
        return;
      }

      setShowSilenceHint(true);
      maybeCommitReceipt();
    },
    [commitMessage, providerKind, verbosity, paymentWalletAddress],
  );

  const processTurn = useCallback(
    async (turnInput: ChatTurnInput): Promise<void> => {
      inFlightRef.current = true;
      setPendingEscInterrupt(false);
      setTurnStartedAtMs(Date.now());
      setElapsedMs(0);
      setPhase('thinking');
      setShowSilenceHint(false);
      setShowTypingDots(false);
      lastFlushedLenRef.current = 0;
      setActiveAttachmentCount(turnInput.attachments?.length ?? 0);
      if (providerKind === 'mpp') {
        setLatestPaymentState('pending');
        setLatestPaymentDetail('awaiting payment confirmation');
        setLatestPaymentTxHash(undefined);
      }

      setLastUserInput(turnInput);
      commitMessage(createMessage('user', formatUserInputMessage(turnInput), false));

      const assistantMessageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setActiveMessage({
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        timestampMs: Date.now(),
      });
      setActiveReasoningTrace('');
      setToolCalls([]);

      const turn = startTurn(turnInput);
      activeCancelRef.current = turn.cancel;

      let streamedText = '';
      let reasoningTrace = '';
      let turnUsage: TurnUsageSummary | null = null;
      let doneResult: ChatTurnResult = { kind: 'silence', reason: 'turn_incomplete' };
      let paymentStateForTurn: PaymentState = providerKind === 'mpp' ? 'pending' : 'ready';

      try {
        for await (const event of turn.events) {
          if (event.type === 'phase') {
            setPhase(event.phase);
            continue;
          }

          if (event.type === 'text_delta') {
            streamedText += event.text;
            const after = lastFlushedLenRef.current;
            const pending = streamedText.slice(after);
            const sentenceEnd = pending.search(/[.?!]\s|[.?!]$/u);
            const paraBreak = pending.indexOf('\n\n');
            const boundary =
              sentenceEnd >= 0
                ? after + sentenceEnd + (pending[sentenceEnd + 1] === ' ' ? 2 : 1)
                : paraBreak >= 0
                  ? after + paraBreak + 2
                  : pending.length > 200
                    ? streamedText.length
                    : -1;
            if (boundary > after) {
              lastFlushedLenRef.current = boundary;
              const visible = streamedText.slice(0, boundary);
              setActiveMessage((prev) => {
                if (!prev || prev.id !== assistantMessageId) return prev;
                return { ...prev, content: visible };
              });
            }
            continue;
          }

          if (event.type === 'reasoning_delta') {
            reasoningTrace += event.text;
            setActiveReasoningTrace(reasoningTrace);
            setActiveMessage((prev) => {
              if (!prev || prev.id !== assistantMessageId) return prev;
              return { ...prev, reasoningTrace };
            });
            continue;
          }

          if (event.type === 'tool_call') {
            setToolCalls((prev) => [
              ...prev,
              {
                id: event.toolCallId,
                name: event.toolName,
                status: 'running',
                ...(event.input !== undefined
                  ? { inputSummary: summarizeUnknown(event.input) }
                  : {}),
              },
            ]);
            continue;
          }

          if (event.type === 'tool_result') {
            setToolCalls((prev) =>
              prev.map((tool) =>
                tool.id === event.toolCallId
                  ? {
                      ...tool,
                      status: 'done',
                      ...(event.output !== undefined
                        ? { outputSummary: summarizeUnknown(event.output) }
                        : {}),
                    }
                  : tool,
              ),
            );
            continue;
          }

          if (event.type === 'meta') {
            const isError = event.message.toLowerCase().startsWith('error:');
            if (providerKind === 'mpp' && isError) {
              const detail = event.message.replace(/^error:\s*/iu, '').trim();
              const nextState = classifyPaymentState(detail);
              paymentStateForTurn = nextState;
              setLatestPaymentState(nextState);
              setLatestPaymentDetail(detail);
              if (verbosity === 'compact') {
                const alert = renderCard('payment issue', [
                  `${icons.toolError} ${paymentStateLabel(nextState)}`,
                  detail || 'payment flow hit an error',
                ]);
                commitMessage(createMessage('meta', alert, false, { kind: 'alert' }));
              }
            }
            commitMeta(event.message, { force: isError });
            continue;
          }

          if (event.type === 'usage') {
            turnUsage = event.summary;
            setSessionUsage((prev) => addUsage(prev, event.summary.usage));
            setSessionLlmCalls((prev) => prev + event.summary.llmCalls);
            if (providerKind === 'mpp') {
              paymentStateForTurn = 'success';
              setLatestPaymentState('success');
              setLatestPaymentDetail('payment confirmed');
              if (event.summary.txHash) setLatestPaymentTxHash(event.summary.txHash);
            }
            continue;
          }

          if (event.type === 'reset_stream') {
            streamedText = '';
            reasoningTrace = '';
            lastFlushedLenRef.current = 0;
            setActiveReasoningTrace('');
            setActiveMessage((prev) =>
              prev && prev.id === assistantMessageId
                ? { ...prev, content: '', reasoningTrace: '' }
                : prev,
            );
            setToolCalls([]);
            continue;
          }

          if (event.type === 'done') {
            doneResult = event.result;
            if (providerKind === 'mpp' && event.result.kind === 'silence') {
              if (event.result.reason === 'interrupted') {
                paymentStateForTurn = 'cancelled';
                setLatestPaymentState('cancelled');
                setLatestPaymentDetail('operator interrupted the request');
              } else if (event.result.reason === 'turn_error') {
                paymentStateForTurn = 'failed';
                setLatestPaymentState('failed');
              } else if (paymentStateForTurn === 'pending') {
                paymentStateForTurn = 'ready';
                setLatestPaymentState('ready');
                setLatestPaymentDetail('no payment charged');
              }
            } else if (providerKind === 'mpp' && paymentStateForTurn === 'pending') {
              paymentStateForTurn = 'success';
              setLatestPaymentState('success');
              setLatestPaymentDetail('response completed');
            }
          }
        }
      } catch (err) {
        logInkError('ink_turn_error', err);
        if (providerKind === 'mpp') {
          const detail = err instanceof Error ? err.message : String(err);
          paymentStateForTurn = classifyPaymentState(detail);
          setLatestPaymentState(paymentStateForTurn);
          setLatestPaymentDetail(detail);
        }
        commitMessage(createMessage('meta', 'something went wrong. try again.', false));
      } finally {
        setActiveMessage(null);
        setShowTypingDots(false);
        finalizeTurn(
          assistantMessageId,
          streamedText,
          reasoningTrace,
          doneResult,
          turnUsage,
          paymentStateForTurn,
        );
        setActiveReasoningTrace('');
        setToolCalls([]);
        setPhase('idle');
        setTurnStartedAtMs(null);
        setElapsedMs(0);
        setActiveAttachmentCount(0);
        setMetrics((prev) => ({ turns: prev.turns + 1, queued: pendingQueueRef.current.length }));
        inFlightRef.current = false;
        activeCancelRef.current = null;
      }
    },
    [commitMessage, commitMeta, finalizeTurn, providerKind, startTurn, verbosity],
  );

  const processQueueFrom = useCallback(
    async (initialInput: ChatTurnInput): Promise<void> => {
      let next: ChatTurnInput | undefined = initialInput;
      while (next) {
        await processTurn(next);
        next = pendingQueueRef.current.shift();
        syncQueuedCount();
      }
    },
    [processTurn, syncQueuedCount],
  );

  const queueOrRun = useCallback(
    (turnInput: ChatTurnInput): void => {
      if (
        !turnInput.text.trim() &&
        (!turnInput.attachments || turnInput.attachments.length === 0)
      ) {
        return;
      }
      if (inFlightRef.current) {
        pendingQueueRef.current.push(turnInput);
        syncQueuedCount();
        return;
      }
      void processQueueFrom(turnInput);
    },
    [processQueueFrom, syncQueuedCount],
  );

  const runSlashCommand = useCallback(
    (rawInput: string): void => {
      const [command] = rawInput.trim().split(/\s+/u);
      if (!command) return;

      if (command === '/exit' || command === '/quit') {
        exit();
        return;
      }
      if (command === '/clear') {
        setCommittedMessages([]);
        setActiveMessage(null);
        setActiveReasoningTrace('');
        setToolCalls([]);
        return;
      }
      if (command === '/help' || command === '/commands') {
        const lines = [
          'just type to chat',
          '',
          ...COMMANDS.map((c) => `  ${c.cmd.padEnd(12)} ${c.desc}`),
          '',
          '  ↑ / ↓        previous messages',
          '  tab          complete command',
          '  ctrl+c       stop (or exit if idle)',
          '  ctrl+o       toggle detail level',
          '  esc ×2       interrupt',
        ];
        commitMessage(createMessage('meta', lines.join('\n'), false));
        return;
      }
      if (command === '/verbose') {
        setVerbosity('verbose');
        commitMessage(createMessage('meta', 'showing more detail', false));
        return;
      }
      if (command === '/compact') {
        setVerbosity('compact');
        commitMessage(createMessage('meta', 'keeping it simple', false));
        return;
      }
      if (command === '/retry') {
        if (lastUserInput) {
          queueOrRun(lastUserInput);
        } else {
          commitMessage(createMessage('meta', 'nothing to retry yet', false));
        }
        return;
      }
      if (command === '/wallet') {
        const lines = [
          `network: ${TEMPO_CHAIN_LABEL}`,
          `agent: ${agentWalletAddress ? shortAddress(agentWalletAddress) : 'not configured'}`,
          ...(agentWalletAddress ? [`agent.full: ${agentWalletAddress}`] : []),
          ...(providerKind === 'mpp'
            ? [
                `payment mode: pay-per-use`,
                paymentWalletAddress
                  ? `payment: ${shortAddress(paymentWalletAddress)}`
                  : `payment: not configured`,
                ...(paymentWalletAddress
                  ? [`payment.account: ${TEMPO_EXPLORER_BASE_URL}/address/${paymentWalletAddress}`]
                  : ['set MPP_PRIVATE_KEY in .env and rerun homie doctor --verify-mpp']),
              ]
            : ['payment mode: disabled (provider is not mpp)']),
          `funding: ${MPP_FUNDING_URL}`,
          `explorer: ${TEMPO_EXPLORER_BASE_URL}`,
          ...(latestPaymentDetail ? [`latest: ${latestPaymentDetail}`] : []),
        ];
        commitMessage(createMessage('meta', lines.join('\n'), false));
        return;
      }
      if (command === '/cost') {
        if (providerKind !== 'mpp') {
          commitMessage(
            createMessage('meta', 'cost tracking is only available in mpp mode', false),
          );
          return;
        }
        const totalTokens = sessionUsage.inputTokens + sessionUsage.outputTokens;
        const lines = [
          `state: ${paymentStateLabel(latestPaymentState)}`,
          `llm.calls: ${formatCount(sessionLlmCalls)}`,
          `in.tokens: ${formatCount(sessionUsage.inputTokens)}`,
          `out.tokens: ${formatCount(sessionUsage.outputTokens)}`,
          `total.tokens: ${formatCount(totalTokens)}`,
          `session.cost: ${formatUsd(sessionUsage.costUsd)}`,
          ...(latestPaymentTxHash
            ? [`tx: ${TEMPO_EXPLORER_BASE_URL}/tx/${latestPaymentTxHash}`]
            : []),
        ];
        commitMessage(createMessage('meta', lines.join('\n'), false));
        return;
      }
      if (command === '/attach') {
        const parsed = parseAttachArgs(rawInput);
        if ('error' in parsed) {
          commitMessage(createMessage('meta', parsed.error, false));
          return;
        }
        queueOrRun({
          text: parsed.text || 'sharing a file',
          attachments: [parsed.attachment],
        });
        return;
      }
      if (command === '/status') {
        const totalTokens = sessionUsage.inputTokens + sessionUsage.outputTokens;
        const lines = [
          `model: ${modelLabel}`,
          ...(providerKind === 'mpp' && paymentWalletAddress
            ? [`payment.wallet: ${shortAddress(paymentWalletAddress)}`]
            : []),
          ...(agentWalletAddress ? [`agent.wallet: ${shortAddress(agentWalletAddress)}`] : []),
          ...(providerKind === 'mpp'
            ? [
                `network: ${TEMPO_CHAIN_LABEL}`,
                `wallet mode: pay-per-use`,
                `payment.state: ${paymentStateLabel(latestPaymentState)}`,
                `session.llmCalls: ${formatCount(sessionLlmCalls)}`,
                `session.inTokens: ${formatCount(sessionUsage.inputTokens)}`,
                `explorer: ${TEMPO_EXPLORER_BASE_URL}`,
              ]
            : []),
          ...(providerKind === 'mpp'
            ? [`session.outTokens: ${formatCount(sessionUsage.outputTokens)}`]
            : []),
          ...(providerKind === 'mpp' ? [`session.totalTokens: ${formatCount(totalTokens)}`] : []),
          ...(providerKind === 'mpp' && sessionUsage.costUsd > 0
            ? [`session.cost: ${formatUsd(sessionUsage.costUsd)}`]
            : []),
          ...(providerKind === 'mpp' && latestPaymentTxHash
            ? [`payment.tx: ${TEMPO_EXPLORER_BASE_URL}/tx/${latestPaymentTxHash}`]
            : []),
          ...(providerKind === 'mpp' && latestPaymentDetail
            ? [`payment.detail: ${latestPaymentDetail}`]
            : []),
          `turns: ${metrics.turns}`,
          `view: ${verbosity}`,
          ...(metrics.queued > 0 ? [`waiting: ${metrics.queued}`] : []),
        ];
        commitMessage(createMessage('meta', lines.join('\n'), false));
        return;
      }
      commitMessage(createMessage('meta', `hmm, don't know ${command} — try /help`, false));
    },
    [
      commitMessage,
      exit,
      lastUserInput,
      metrics.queued,
      metrics.turns,
      modelLabel,
      providerKind,
      queueOrRun,
      agentWalletAddress,
      latestPaymentDetail,
      latestPaymentState,
      latestPaymentTxHash,
      sessionLlmCalls,
      paymentWalletAddress,
      sessionUsage.costUsd,
      sessionUsage.inputTokens,
      sessionUsage.outputTokens,
      verbosity,
    ],
  );

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      if (inFlightRef.current && activeCancelRef.current) {
        activeCancelRef.current();
        commitMessage(createMessage('meta', 'stopped', false));
        return;
      }
      exit();
      return;
    }

    if (key.ctrl && ch?.toLowerCase() === 'o') {
      setVerbosity((prev) => (prev === 'compact' ? 'verbose' : 'compact'));
      return;
    }

    if (key.escape) {
      if (inFlightRef.current && activeCancelRef.current) {
        const now = Date.now();
        if (now - lastEscAtMsRef.current < 1500) {
          activeCancelRef.current();
          setPendingEscInterrupt(false);
          commitMessage(createMessage('meta', 'stopped', false));
        } else {
          lastEscAtMsRef.current = now;
          setPendingEscInterrupt(true);
        }
        return;
      }
      setInput('');
      historyOffsetRef.current = 0;
      return;
    }

    if (key.tab) {
      const matches = commandMatches(input);
      if (matches.length === 1 && matches[0]) setInput(matches[0].cmd);
      return;
    }

    if (key.upArrow) {
      if (inputHistory.length === 0) return;
      if (historyOffsetRef.current === 0) savedDraftRef.current = input;
      const next = Math.min(historyOffsetRef.current + 1, inputHistory.length);
      if (next !== historyOffsetRef.current) {
        historyOffsetRef.current = next;
        setInput(inputHistory[inputHistory.length - next] ?? '');
      }
      return;
    }

    if (key.downArrow) {
      if (historyOffsetRef.current <= 0) return;
      historyOffsetRef.current -= 1;
      if (historyOffsetRef.current === 0) {
        setInput(savedDraftRef.current);
      } else {
        setInput(inputHistory[inputHistory.length - historyOffsetRef.current] ?? '');
      }
      return;
    }

    if (key.return) {
      const normalized = input.trim();
      if (!normalized) return;
      setInputHistory((prev) => [...prev.slice(-99), normalized]);
      historyOffsetRef.current = 0;
      setInput('');
      if (normalized.startsWith('/')) runSlashCommand(normalized);
      else queueOrRun({ text: normalized });
    } else if (key.backspace || key.delete) {
      historyOffsetRef.current = 0;
      setInput((prev) => {
        const chars = Array.from(prev);
        chars.pop();
        return chars.join('');
      });
    } else if (ch && !key.ctrl && !key.meta) {
      historyOffsetRef.current = 0;
      setInput((prev) => prev + ch);
    }
  });

  useEffect(() => {
    if (phase === 'idle' || turnStartedAtMs === null) {
      cliCursor.show();
      return;
    }
    cliCursor.hide();
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - turnStartedAtMs);
    }, 500);
    return () => {
      clearInterval(timer);
      cliCursor.show();
    };
  }, [phase, turnStartedAtMs]);

  useEffect(() => {
    return () => cliCursor.show();
  }, []);

  useEffect(() => {
    if (!showSilenceHint) return;
    const timer = setTimeout(() => setShowSilenceHint(false), 3000);
    return () => clearTimeout(timer);
  }, [showSilenceHint]);

  useEffect(() => {
    const isThinking = phase !== 'idle' && (!activeMessage || activeMessage.content.length === 0);
    if (!isThinking) {
      setShowTypingDots(false);
      return;
    }
    const timer = setTimeout(() => setShowTypingDots(true), 400);
    return () => clearTimeout(timer);
  }, [phase, activeMessage]);

  const visibleCommands = useMemo(() => commandMatches(input).slice(0, 4), [input]);
  const latestRunningToolName = useMemo(() => {
    for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
      const tool = toolCalls[i];
      if (tool?.status === 'running') return tool.name;
    }
    return undefined;
  }, [toolCalls]);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>
          {'  '}
          {formatBrand()}
        </Text>
      </Box>

      {committedMessages.length === 0 && !activeMessage && (
        <Box justifyContent="center" marginBottom={1}>
          <Text color="gray" dimColor>
            /help for commands
          </Text>
        </Box>
      )}

      <Static items={committedMessages}>
        {(msg, index) => {
          const prev = index > 0 ? committedMessages[index - 1] : undefined;
          const senderChanged = prev !== undefined && prev.role !== msg.role;
          const showTs = shouldShowTimestamp(msg, prev);
          const gap = senderChanged || showTs || index === 0 ? 1 : 0;

          return (
            <Box key={msg.id} flexDirection="column" marginTop={gap}>
              {showTs && <TimestampDivider timestampMs={msg.timestampMs} />}
              <Message message={msg} verbosity={verbosity} />
            </Box>
          );
        }}
      </Static>

      {activeMessage && activeMessage.content.length > 0 && (
        <Box marginTop={1}>
          <Message
            message={{
              ...activeMessage,
              reasoningTrace: activeMessage.reasoningTrace ?? activeReasoningTrace,
            }}
            toolCalls={toolCalls}
            verbosity={verbosity}
          />
        </Box>
      )}

      {showTypingDots && (!activeMessage || activeMessage.content.length === 0) && (
        <Box marginTop={1}>
          <TypingIndicator />
        </Box>
      )}

      <Box marginTop={1}>
        {input ? (
          <Text>
            {input}
            <Text color="gray">{icons.inputCursor}</Text>
          </Text>
        ) : (
          <Text color="gray" dimColor>
            {placeholderText}
          </Text>
        )}
      </Box>

      {visibleCommands.length > 0 && (
        <Box marginLeft={2} flexDirection="column">
          {visibleCommands.map((command) => (
            <Text key={command.cmd} color="gray">
              <Text color="cyan">{icons.command + command.cmd.slice(1)}</Text> {command.desc}
            </Text>
          ))}
        </Box>
      )}

      <StatusBar
        modelLabel={modelLabel}
        metrics={metrics}
        phase={phase}
        verbosity={verbosity}
        elapsedMs={elapsedMs}
        hasPendingInterrupt={pendingEscInterrupt}
        latestToolName={latestRunningToolName}
        showSilenceHint={showSilenceHint}
        activeAttachmentCount={activeAttachmentCount}
        providerKind={providerKind}
        sessionUsage={sessionUsage}
        agentWalletAddress={agentWalletAddress}
        paymentWalletAddress={paymentWalletAddress}
        paymentState={latestPaymentState}
        paymentTxHash={latestPaymentTxHash}
      />
    </Box>
  );
}
