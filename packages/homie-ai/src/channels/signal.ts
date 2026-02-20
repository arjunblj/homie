import type { IncomingMessage } from '../agent/types.js';
import type { HomieConfig } from '../config/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import type { FeedbackTracker } from '../feedback/tracker.js';
import { makeOutgoingRefKey } from '../feedback/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { assertNever } from '../util/assert-never.js';
import { errorFields, log } from '../util/logger.js';
import { ReconnectGuard, runWithRetries, ShortLivedDedupeCache } from './reliability.js';
import { runSignalDaemonAdapter } from './signal-daemon.js';
import { parseSignalAttachments, type SignalDataMessageAttachment } from './signal-shared.js';

export interface SignalConfig {
  apiUrl: string;
  number: string;
  operatorNumber?: string | undefined;
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  timestamp?: number;
  dataMessage?: {
    message?: string;
    groupInfo?: { groupId?: string };
    timestamp?: number;
    attachments?: SignalDataMessageAttachment[];
    reaction?: {
      emoji?: string;
      remove?: boolean;
      targetAuthor?: string;
      targetSentTimestamp?: number;
    };
  };
}

const resolveSignalConfig = (env: NodeJS.ProcessEnv): SignalConfig => {
  interface SigEnv extends NodeJS.ProcessEnv {
    SIGNAL_API_URL?: string;
    SIGNAL_NUMBER?: string;
    SIGNAL_OPERATOR_NUMBER?: string;
  }
  const e = env as SigEnv;
  const apiUrl = e.SIGNAL_API_URL?.trim();
  const number = e.SIGNAL_NUMBER?.trim();
  if (!apiUrl || !number) {
    throw new Error('Signal adapter requires SIGNAL_API_URL and SIGNAL_NUMBER.');
  }
  return {
    apiUrl: apiUrl.replace(/\/+$/u, ''),
    number,
    operatorNumber: e.SIGNAL_OPERATOR_NUMBER?.trim(),
  };
};

const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

const parseRetryAfterMs = (raw: string | null | undefined, fallbackMs: number): number => {
  if (!raw) return fallbackMs;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  return fallbackMs;
};

interface RetryableSendError extends Error {
  retryable?: boolean;
  retryAfterMs?: number | undefined;
}

const makeSendError = (
  message: string,
  retryable: boolean,
  retryAfterMs?: number | undefined,
): RetryableSendError => {
  const err = new Error(message) as RetryableSendError;
  err.retryable = retryable;
  err.retryAfterMs = retryAfterMs;
  return err;
};

const sendSignalMessage = async (
  cfg: SignalConfig,
  recipient: string,
  text: string,
): Promise<number | undefined> => {
  const body = { message: text, number: cfg.number, recipients: [recipient] };
  const idempotencyKey = `sig:${cfg.number}:${recipient}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const sendOnce = async (): Promise<number | undefined> => {
    let res: Response;
    try {
      res = await fetch(`${cfg.apiUrl}/v2/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw makeSendError(
        `Signal send failed: network ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), 1000);
      throw makeSendError(
        `Signal send failed: HTTP ${res.status} ${detail.slice(0, 300)}`,
        isTransientStatus(res.status),
        retryAfterMs,
      );
    }
    try {
      const json = (await res.json()) as { timestamp?: number } | undefined;
      return typeof json?.timestamp === 'number' ? json.timestamp : undefined;
    } catch (_err) {
      return undefined;
    }
  };

  return await runWithRetries(sendOnce, {
    maxAttempts: 4,
    baseDelayMs: 1000,
    maxDelayMs: 15_000,
    minDelayMs: 500,
    jitterFraction: 0.1,
    shouldRetry: (err) => Boolean((err as RetryableSendError | undefined)?.retryable),
    computeRetryDelayMs: (err, computedMs) =>
      Math.max(
        computedMs,
        Math.max(0, Math.floor((err as RetryableSendError | undefined)?.retryAfterMs ?? 0)),
      ),
  });
};

const sendSignalReaction = async (
  cfg: SignalConfig,
  recipient: string,
  targetAuthor: string,
  targetTimestamp: number,
  emoji: string,
): Promise<void> => {
  const body = {
    reaction: emoji,
    recipient,
    target_author: targetAuthor,
    timestamp: targetTimestamp,
  };
  const res = await fetch(`${cfg.apiUrl}/v1/reactions/${cfg.number}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Non-critical; log but don't throw.
    const detail = await res.text().catch(() => '');
    log.child({ component: 'signal' }).warn('reaction.failed', {
      status: res.status,
      detail: detail.slice(0, 500),
    });
  }
};

const typingEnabled = (): boolean => {
  const env = process.env as NodeJS.ProcessEnv & { HOMIE_SIGNAL_TYPING?: string };
  return (env.HOMIE_SIGNAL_TYPING ?? '').trim() === '1';
};

const sendSignalTypingIndicator = async (
  cfg: SignalConfig,
  recipient: string,
  show: boolean,
): Promise<void> => {
  try {
    const res = await fetch(`${cfg.apiUrl}/v1/typing-indicator/${cfg.number}`, {
      method: show ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient }),
    });
    // Non-critical: ignore failures.
    void res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.child({ component: 'signal' }).warn('typing_indicator.failed', { errMsg: msg });
  }
};

const typingState = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();

const acquireTyping = (cfg: SignalConfig, recipient: string): (() => Promise<void>) => {
  const key = recipient;
  const existing = typingState.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    const tick = (): void => void sendSignalTypingIndicator(cfg, recipient, true);
    tick();
    const timer = setInterval(tick, 10_000);
    typingState.set(key, { count: 1, timer });
  }

  return async () => {
    const cur = typingState.get(key);
    if (!cur) return;
    cur.count -= 1;
    if (cur.count > 0) return;
    clearInterval(cur.timer);
    typingState.delete(key);
    await sendSignalTypingIndicator(cfg, recipient, false);
  };
};

export interface RunSignalAdapterOptions {
  config: HomieConfig;
  engine: TurnEngine;
  feedback?: FeedbackTracker | undefined;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
}

export const runSignalAdapter = async ({
  config,
  engine,
  feedback,
  env,
  signal,
}: RunSignalAdapterOptions): Promise<void> => {
  const logger = log.child({ component: 'signal' });
  type SignalEnv = NodeJS.ProcessEnv & {
    SIGNAL_DAEMON_URL?: string | undefined;
    SIGNAL_HTTP_URL?: string | undefined;
  };
  const e = (env ?? process.env) as SignalEnv;
  const daemonUrl = e.SIGNAL_DAEMON_URL?.trim() ?? e.SIGNAL_HTTP_URL?.trim();
  if (daemonUrl) {
    await runSignalDaemonAdapter({ config, engine, feedback, env: e, signal });
    return;
  }

  const sigCfg = resolveSignalConfig(e);
  const wsUrl = `${sigCfg.apiUrl.replace(/^http/u, 'ws')}/v1/receive/${sigCfg.number}`;
  if (signal?.aborted) return;

  let ws: WebSocket | undefined;
  const reconnectGuard = new ReconnectGuard();
  let reconnectAttempt = 0;
  const incomingDedupe = new ShortLivedDedupeCache({ ttlMs: 120_000, maxEntries: 20_000 });

  const scheduleReconnect = (): void => {
    if (signal?.aborted) return;
    const waitMs = Math.max(500, Math.min(30_000, 1000 * 2 ** reconnectAttempt));
    const scheduled = reconnectGuard.schedule(waitMs, () => {
      reconnectAttempt += 1;
      connect();
    });
    if (scheduled)
      logger.warn('disconnected.reconnecting', { waitMs, attempt: reconnectAttempt + 1 });
  };

  const connect = (): void => {
    if (signal?.aborted) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.addEventListener('open', () => {
      if (ws !== socket) return;
      reconnectAttempt = 0;
      reconnectGuard.clear();
      logger.info('connected');
    });

    socket.addEventListener('message', (ev) => {
      if (ws !== socket) return;
      void handleWsMessage(ev.data, sigCfg, config, engine, feedback, signal, incomingDedupe);
    });

    socket.addEventListener('close', () => {
      if (ws !== socket) return;
      ws = undefined;
      scheduleReconnect();
    });

    socket.addEventListener('error', (err) => {
      if (ws !== socket) return;
      logger.error('ws.error', { errMsg: String(err) });
      scheduleReconnect();
    });
  };

  connect();

  if (signal) {
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          reconnectGuard.clear();
          try {
            ws?.close();
          } catch (err) {
            logger.debug('ws.close_failed', errorFields(err));
          }
          resolve();
        },
        { once: true },
      );
    });
    return;
  }

  // Keep alive forever.
  await new Promise<never>(() => {});
};

const handleWsMessage = async (
  raw: unknown,
  sigCfg: SignalConfig,
  _config: HomieConfig,
  engine: TurnEngine,
  feedback?: FeedbackTracker | undefined,
  signal?: AbortSignal | undefined,
  dedupe?: ShortLivedDedupeCache | undefined,
): Promise<void> => {
  try {
    const data =
      typeof raw === 'string' ? (JSON.parse(raw) as { envelope?: SignalEnvelope }) : null;
    const envelope = data?.envelope;
    if (!envelope) return;

    const source = envelope.sourceNumber ?? envelope.source ?? '';
    const groupId = envelope.dataMessage?.groupInfo?.groupId;
    const isGroup = !!groupId;
    const chatId = asChatId(groupId ? `signal:group:${groupId}` : `signal:dm:${source}`);
    const ts = envelope.dataMessage?.timestamp ?? envelope.timestamp ?? Date.now();
    const isOperator = source === sigCfg.operatorNumber;

    const reaction = envelope.dataMessage?.reaction;
    const emoji = reaction?.emoji?.trim();
    const targetAuthor = reaction?.targetAuthor?.trim();
    const targetSentTimestamp = reaction?.targetSentTimestamp;
    if (emoji && targetAuthor && typeof targetSentTimestamp === 'number') {
      const reactionKey = `signal:reaction:${chatId}:${source}:${targetAuthor}:${targetSentTimestamp}:${emoji}:${reaction?.remove ? '1' : '0'}:${ts}`;
      if (dedupe?.seen(reactionKey)) return;

      const run = async (): Promise<void> => {
        feedback?.onIncomingReaction({
          channel: 'signal',
          chatId,
          targetRefKey: makeOutgoingRefKey(chatId, {
            channel: 'signal',
            targetAuthor,
            targetTimestampMs: targetSentTimestamp,
          }),
          emoji,
          isRemove: reaction?.remove === true,
          authorId: source,
          timestampMs: ts,
        });
      };

      await run();
      return;
    }

    const attachments = parseSignalAttachments(envelope.dataMessage?.attachments ?? [], ts);

    const text = envelope.dataMessage?.message?.trim() ?? '';
    if (!text && (!attachments || attachments.length === 0)) return;

    const messageKey = `signal:message:${chatId}:${source}:${ts}`;
    if (dedupe?.seen(messageKey)) return;

    const msg: IncomingMessage = {
      channel: 'signal',
      chatId,
      messageId: asMessageId(`signal:${ts}`),
      authorId: source,
      text,
      ...(attachments?.length ? { attachments } : {}),
      isGroup,
      isOperator,
      timestampMs: ts,
    };

    feedback?.onIncomingReply({
      channel: 'signal',
      chatId,
      authorId: source,
      text,
      timestampMs: ts,
    });

    const run = async (): Promise<void> => {
      if (signal?.aborted) return;
      const showTyping = typingEnabled() && !isGroup;
      const releaseTyping = showTyping ? acquireTyping(sigCfg, source) : undefined;
      try {
        const out = await engine.handleIncomingMessage(msg);
        const recipient = groupId ?? source;

        switch (out.kind) {
          case 'send_text': {
            const sentAt = Date.now();
            const tsSent = (await sendSignalMessage(sigCfg, recipient, out.text)) ?? sentAt;
            feedback?.onOutgoingSent({
              channel: 'signal',
              chatId,
              refKey: makeOutgoingRefKey(chatId, {
                channel: 'signal',
                targetAuthor: sigCfg.number,
                targetTimestampMs: tsSent,
              }),
              isGroup,
              sentAtMs: tsSent,
              text: out.text,
              primaryChannelUserId: `${msg.channel}:${msg.authorId}`,
            });
            break;
          }
          case 'react': {
            await sendSignalReaction(
              sigCfg,
              recipient,
              out.targetAuthorId,
              out.targetTimestampMs,
              out.emoji,
            );
            break;
          }
          case 'silence':
            break;
          default:
            assertNever(out);
        }
      } finally {
        await releaseTyping?.();
      }
    };

    await run();
  } catch (err) {
    log.child({ component: 'signal' }).error('handler.error', errorFields(err));
  }
};

export { handleWsMessage as handleSignalWsMessageForTest };
