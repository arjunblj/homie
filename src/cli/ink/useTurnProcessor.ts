import cliCursor from 'cli-cursor';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  classifyPaymentState,
  createMessage,
  formatTurnReceiptCard,
  formatUserInputMessage,
  logInkError,
  MAX_COMMITTED_MESSAGES,
  paymentStateLabel,
  renderCard,
  STREAM_FLUSH_DEBOUNCE_MS,
  summarizeUnknown,
} from './format.js';
import { icons } from './theme.js';
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
} from './types.js';
import type { PaymentTracker } from './usePaymentTracker.js';
import type { SessionUsageTracker } from './useSessionUsage.js';

export interface TurnProcessorOptions {
  startTurn: ChatTurnStreamer;
  providerKind: string;
  paymentWalletAddress: string | undefined;
  payment: PaymentTracker;
  session: SessionUsageTracker;
}

export interface TurnProcessorState {
  committedMessages: ChatMessage[];
  activeMessage: ChatMessage | null;
  toolCalls: ToolCallState[];
  phase: ChatPhase;
  metrics: SessionMetrics;
  activeReasoningTrace: string;
  turnStartedAtMs: number | null;
  elapsedMs: number;
  pendingEscInterrupt: boolean;
  lastUserInput: ChatTurnInput | null;
  showSilenceHint: boolean;
  activeAttachmentCount: number;
  showTypingDots: boolean;
  historyTrimmedCount: number;

  commitMessage: (message: ChatMessage) => void;
  queueOrRun: (turnInput: ChatTurnInput) => void;
  clearAll: () => void;

  inFlightRef: MutableRefObject<boolean>;
  activeCancelRef: MutableRefObject<(() => void) | null>;
  lastEscAtMsRef: MutableRefObject<number>;

  setPendingEscInterrupt: Dispatch<SetStateAction<boolean>>;
}

export function useTurnProcessor(options: TurnProcessorOptions): TurnProcessorState {
  const { startTurn, providerKind, paymentWalletAddress, payment, session } = options;

  const [committedMessages, setCommittedMessages] = useState<ChatMessage[]>([]);
  const [activeMessage, setActiveMessage] = useState<ChatMessage | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([]);
  const [phase, setPhase] = useState<ChatPhase>('idle');
  const [metrics, setMetrics] = useState<SessionMetrics>({ turns: 0, queued: 0 });
  const [activeReasoningTrace, setActiveReasoningTrace] = useState('');
  const [turnStartedAtMs, setTurnStartedAtMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pendingEscInterrupt, setPendingEscInterrupt] = useState(false);
  const [lastUserInput, setLastUserInput] = useState<ChatTurnInput | null>(null);
  const [showSilenceHint, setShowSilenceHint] = useState(false);
  const [activeAttachmentCount, setActiveAttachmentCount] = useState(0);
  const [showTypingDots, setShowTypingDots] = useState(false);
  const [historyTrimmedCount, setHistoryTrimmedCount] = useState(0);

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
        const receipt = formatTurnReceiptCard(turnUsage, paymentStateForTurn, paymentWalletAddress);
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
    [commitMessage, providerKind, paymentWalletAddress],
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
            setToolCalls((prev) => {
              const existing = prev.find((tool) => tool.id === event.toolCallId);
              if (existing) {
                return prev.map((tool) =>
                  tool.id === event.toolCallId
                    ? {
                        ...tool,
                        status: 'running',
                        ...(event.input !== undefined
                          ? { inputSummary: summarizeUnknown(event.input) }
                          : {}),
                      }
                    : tool,
                );
              }
              return [
                ...prev,
                {
                  id: event.toolCallId,
                  name: event.toolName,
                  status: 'running',
                  startedAtMs: Date.now(),
                  ...(event.input !== undefined
                    ? { inputSummary: summarizeUnknown(event.input) }
                    : {}),
                },
              ];
            });
            continue;
          }

          if (event.type === 'tool_input_start') {
            setToolCalls((prev) => {
              const existing = prev.find((tool) => tool.id === event.toolCallId);
              if (existing) return prev;
              return [
                ...prev,
                {
                  id: event.toolCallId,
                  name: event.toolName,
                  status: 'running',
                  startedAtMs: Date.now(),
                },
              ];
            });
            continue;
          }

          if (event.type === 'tool_input_delta') {
            setToolCalls((prev) => {
              const existing = prev.find((tool) => tool.id === event.toolCallId);
              if (!existing) {
                return [
                  ...prev,
                  {
                    id: event.toolCallId,
                    name: event.toolName,
                    status: 'running',
                    startedAtMs: Date.now(),
                    inputDeltaPreview: event.delta.slice(-220),
                  },
                ];
              }
              return prev.map((tool) =>
                tool.id === event.toolCallId
                  ? {
                      ...tool,
                      inputDeltaPreview: `${tool.inputDeltaPreview ?? ''}${event.delta}`.slice(
                        -220,
                      ),
                    }
                  : tool,
              );
            });
            continue;
          }

          if (event.type === 'tool_input_end') {
            setToolCalls((prev) => {
              const existing = prev.find((tool) => tool.id === event.toolCallId);
              if (!existing) {
                return [
                  ...prev,
                  {
                    id: event.toolCallId,
                    name: event.toolName,
                    status: 'running',
                    startedAtMs: Date.now(),
                  },
                ];
              }
              return prev.map((tool) =>
                tool.id === event.toolCallId
                  ? {
                      ...tool,
                      ...(tool.inputSummary
                        ? {}
                        : {
                            inputSummary: (tool.inputDeltaPreview ?? '').trim() || undefined,
                          }),
                    }
                  : tool,
              );
            });
            continue;
          }

          if (event.type === 'tool_result') {
            setToolCalls((prev) => {
              const existing = prev.find((tool) => tool.id === event.toolCallId);
              if (!existing) {
                return [
                  ...prev,
                  {
                    id: event.toolCallId,
                    name: event.toolName,
                    status: 'done',
                    startedAtMs: Date.now(),
                    ...(event.output !== undefined
                      ? { outputSummary: summarizeUnknown(event.output) }
                      : {}),
                  },
                ];
              }
              return prev.map((tool) =>
                tool.id === event.toolCallId
                  ? {
                      ...tool,
                      status: 'done',
                      ...(event.output !== undefined
                        ? { outputSummary: summarizeUnknown(event.output) }
                        : {}),
                    }
                  : tool,
              );
            });
            continue;
          }

          if (event.type === 'step_finish') {
            continue;
          }

          if (event.type === 'meta') {
            const isError = event.message.toLowerCase().startsWith('error:');
            if (providerKind === 'mpp' && isError) {
              const detail = event.message.replace(/^error:\s*/iu, '').trim();
              const nextState = classifyPaymentState(detail);
              paymentStateForTurn = nextState;
              payment.update(nextState, detail);
              const alert = renderCard('payment issue', [
                `${icons.toolError} ${paymentStateLabel(nextState)}`,
                detail || 'payment flow hit an error',
              ]);
              commitMessage(createMessage('meta', alert, false, { kind: 'alert' }));
            }
            if (isError) {
              commitMessage(createMessage('meta', event.message, false));
            }
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
      finalizeTurn,
      payment.update,
      payment.setTxHash,
      providerKind,
      session.addTurnUsage,
      startTurn,
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

  const clearAll = useCallback((): void => {
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
  }, [syncQueuedCount, payment.reset, session.reset]);

  // ── Effects ────────────────────────────────────────────────────

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

  return {
    committedMessages,
    activeMessage,
    toolCalls,
    phase,
    metrics,
    activeReasoningTrace,
    turnStartedAtMs,
    elapsedMs,
    pendingEscInterrupt,
    lastUserInput,
    showSilenceHint,
    activeAttachmentCount,
    showTypingDots,
    historyTrimmedCount,

    commitMessage,
    queueOrRun,
    clearAll,

    inFlightRef,
    activeCancelRef,
    lastEscAtMsRef,

    setPendingEscInterrupt,
  };
}
