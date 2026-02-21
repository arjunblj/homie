import cliCursor from 'cli-cursor';
import { Box, Static, Text, useApp, useInput } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMANDS,
  classifyPaymentState,
  commandMatches,
  createMessage,
  formatCount,
  formatTurnReceiptCard,
  formatUsd,
  formatUserInputMessage,
  logInkError,
  MAX_COMMITTED_MESSAGES,
  MPP_FUNDING_URL,
  parseAttachArgs,
  paymentStateLabel,
  renderCard,
  STREAM_FLUSH_DEBOUNCE_MS,
  shortAddress,
  summarizeUnknown,
  TEMPO_CHAIN_LABEL,
  TEMPO_EXPLORER_BASE_URL,
} from './format.js';
import { Message, shouldShowTimestamp, TimestampDivider, TypingIndicator } from './Message.js';
import { StatusBar } from './StatusBar.js';
import { formatBrand, icons, placeholderText } from './theme.js';
import type {
  ChatMessage,
  ChatPhase,
  ChatTurnInput,
  ChatTurnResult,
  ChatTurnStreamer,
  PaymentState,
  SessionMetrics,
  ToolCallState,
  TurnUsageSummary,
  VerbosityMode,
} from './types.js';
import { useInputManager } from './useInputManager.js';
import { usePaymentTracker } from './usePaymentTracker.js';
import { useSessionUsage } from './useSessionUsage.js';

interface AppProps {
  modelLabel: string;
  startTurn: ChatTurnStreamer;
  providerKind: string;
  agentWalletAddress?: string | undefined;
  paymentWalletAddress?: string | undefined;
}

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
  const [phase, setPhase] = useState<ChatPhase>('idle');
  const [metrics, setMetrics] = useState<SessionMetrics>({ turns: 0, queued: 0 });
  const [verbosity, setVerbosity] = useState<VerbosityMode>('compact');
  const [activeReasoningTrace, setActiveReasoningTrace] = useState('');
  const [turnStartedAtMs, setTurnStartedAtMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pendingEscInterrupt, setPendingEscInterrupt] = useState(false);
  const [lastUserInput, setLastUserInput] = useState<ChatTurnInput | null>(null);
  const [showSilenceHint, setShowSilenceHint] = useState(false);
  const [activeAttachmentCount, setActiveAttachmentCount] = useState(0);
  const [showTypingDots, setShowTypingDots] = useState(false);
  const [historyTrimmedCount, setHistoryTrimmedCount] = useState(0);

  const { input, setInput, inputHistory, historyOffsetRef, savedDraftRef, pushToHistory } =
    useInputManager();
  const payment = usePaymentTracker();
  const session = useSessionUsage();

  const inFlightRef = useRef(false);
  const activeCancelRef = useRef<(() => void) | null>(null);
  const pendingQueueRef = useRef<ChatTurnInput[]>([]);
  const lastEscAtMsRef = useRef(0);
  const lastFlushedLenRef = useRef(0);
  const clearEpochRef = useRef(0);

  const commitMessage = useCallback((message: ChatMessage): void => {
    setCommittedMessages((prev) => {
      const next = [...prev, message];
      if (next.length <= MAX_COMMITTED_MESSAGES) return next;
      const trimmed = next.length - MAX_COMMITTED_MESSAGES;
      setHistoryTrimmedCount((count) => count + trimmed);
      return next.slice(-MAX_COMMITTED_MESSAGES);
    });
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

      const silenceHintReasons = new Set([
        'no_reply',
        'model_silence',
        'model_silence_regen',
        'slop_unresolved',
      ]);
      if (silenceHintReasons.has(result.reason ?? '')) {
        setShowSilenceHint(true);
      }
      maybeCommitReceipt();
    },
    [commitMessage, providerKind, verbosity, paymentWalletAddress],
  );

  const processTurn = useCallback(
    async (turnInput: ChatTurnInput): Promise<void> => {
      inFlightRef.current = true;
      const turnEpoch = clearEpochRef.current;
      setPendingEscInterrupt(false);
      setTurnStartedAtMs(Date.now());
      setElapsedMs(0);
      setPhase('thinking');
      setShowSilenceHint(false);
      setShowTypingDots(false);
      lastFlushedLenRef.current = 0;
      setActiveAttachmentCount(turnInput.attachments?.length ?? 0);
      if (providerKind === 'mpp') {
        payment.update('pending', 'awaiting payment confirmation');
        payment.setTxHash(undefined);
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
      let pendingVisibleText: string | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushVisibleText = (): void => {
        if (pendingVisibleText === null) return;
        const visible = pendingVisibleText;
        pendingVisibleText = null;
        setActiveMessage((prev) => {
          if (!prev || prev.id !== assistantMessageId) return prev;
          return { ...prev, content: visible };
        });
      };

      const scheduleVisibleFlush = (): void => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushVisibleText();
        }, STREAM_FLUSH_DEBOUNCE_MS);
      };

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
              pendingVisibleText = streamedText.slice(0, boundary);
              scheduleVisibleFlush();
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
              payment.update(nextState, detail);
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
            session.addTurnUsage(event.summary.usage, event.summary.llmCalls);
            if (providerKind === 'mpp') {
              paymentStateForTurn = 'success';
              payment.update('success', 'payment confirmed');
              if (event.summary.txHash) payment.setTxHash(event.summary.txHash);
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
                payment.update('cancelled', 'operator interrupted the request');
              } else if (event.result.reason === 'turn_error') {
                paymentStateForTurn = 'failed';
                payment.update('failed');
              } else if (paymentStateForTurn === 'pending') {
                paymentStateForTurn = 'ready';
                payment.update('ready', 'no payment charged');
              }
            } else if (providerKind === 'mpp' && paymentStateForTurn === 'pending') {
              paymentStateForTurn = 'success';
              payment.update('success', 'response completed');
            }
          }
        }
      } catch (err) {
        logInkError('ink_turn_error', err);
        if (providerKind === 'mpp') {
          const detail = err instanceof Error ? err.message : String(err);
          paymentStateForTurn = classifyPaymentState(detail);
          payment.update(paymentStateForTurn, detail);
        }
        commitMessage(createMessage('meta', 'something went wrong. try again.', false));
      } finally {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        flushVisibleText();
        setActiveMessage(null);
        setShowTypingDots(false);
        if (turnEpoch === clearEpochRef.current) {
          finalizeTurn(
            assistantMessageId,
            streamedText,
            reasoningTrace,
            doneResult,
            turnUsage,
            paymentStateForTurn,
          );
        }
        setActiveReasoningTrace('');
        setToolCalls([]);
        setPhase('idle');
        setTurnStartedAtMs(null);
        setElapsedMs(0);
        setActiveAttachmentCount(0);
        if (turnEpoch === clearEpochRef.current) {
          setMetrics((prev) => ({ turns: prev.turns + 1, queued: pendingQueueRef.current.length }));
        }
        inFlightRef.current = false;
        activeCancelRef.current = null;
      }
    },
    [
      commitMessage,
      commitMeta,
      finalizeTurn,
      payment.update,
      payment.setTxHash,
      providerKind,
      session.addTurnUsage,
      startTurn,
      verbosity,
    ],
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
        clearEpochRef.current += 1;
        if (activeCancelRef.current) activeCancelRef.current();
        pendingQueueRef.current = [];
        syncQueuedCount();
        setCommittedMessages([]);
        setActiveMessage(null);
        setActiveReasoningTrace('');
        setToolCalls([]);
        setShowSilenceHint(false);
        setPendingEscInterrupt(false);
        setTurnStartedAtMs(null);
        setElapsedMs(0);
        setLastUserInput(null);
        setActiveAttachmentCount(0);
        payment.reset();
        session.reset();
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
          ...(payment.detail ? [`latest: ${payment.detail}`] : []),
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
        const totalTokens = session.usage.inputTokens + session.usage.outputTokens;
        const lines = [
          `state: ${paymentStateLabel(payment.state)}`,
          `llm.calls: ${formatCount(session.llmCalls)}`,
          `in.tokens: ${formatCount(session.usage.inputTokens)}`,
          `out.tokens: ${formatCount(session.usage.outputTokens)}`,
          `total.tokens: ${formatCount(totalTokens)}`,
          `session.cost: ${formatUsd(session.usage.costUsd)}`,
          ...(payment.txHash ? [`tx: ${TEMPO_EXPLORER_BASE_URL}/tx/${payment.txHash}`] : []),
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
        const totalTokens = session.usage.inputTokens + session.usage.outputTokens;
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
                `payment.state: ${paymentStateLabel(payment.state)}`,
                `session.llmCalls: ${formatCount(session.llmCalls)}`,
                `session.inTokens: ${formatCount(session.usage.inputTokens)}`,
                `explorer: ${TEMPO_EXPLORER_BASE_URL}`,
              ]
            : []),
          ...(providerKind === 'mpp'
            ? [`session.outTokens: ${formatCount(session.usage.outputTokens)}`]
            : []),
          ...(providerKind === 'mpp' ? [`session.totalTokens: ${formatCount(totalTokens)}`] : []),
          ...(providerKind === 'mpp' && session.usage.costUsd > 0
            ? [`session.cost: ${formatUsd(session.usage.costUsd)}`]
            : []),
          ...(providerKind === 'mpp' && payment.txHash
            ? [`payment.tx: ${TEMPO_EXPLORER_BASE_URL}/tx/${payment.txHash}`]
            : []),
          ...(providerKind === 'mpp' && payment.detail
            ? [`payment.detail: ${payment.detail}`]
            : []),
          `turns: ${metrics.turns}`,
          `view: ${verbosity}`,
          ...(metrics.queued > 0 ? [`waiting: ${metrics.queued}`] : []),
          ...(historyTrimmedCount > 0
            ? [`history.trimmed: ${formatCount(historyTrimmedCount)}`]
            : []),
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
      payment.detail,
      payment.state,
      payment.txHash,
      payment.reset,
      session.llmCalls,
      session.reset,
      paymentWalletAddress,
      session.usage.costUsd,
      session.usage.inputTokens,
      session.usage.outputTokens,
      verbosity,
      historyTrimmedCount,
      syncQueuedCount,
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
      pushToHistory(normalized);
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
        sessionUsage={session.usage}
        agentWalletAddress={agentWalletAddress}
        paymentWalletAddress={paymentWalletAddress}
        paymentState={payment.state}
        paymentTxHash={payment.txHash}
        historyTrimmedCount={historyTrimmedCount}
      />
    </Box>
  );
}
