import { z } from 'zod';

import type { IncomingMessage } from '../agent/types.js';
import type { OpenhomieConfig } from '../config/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import type { FeedbackTracker } from '../feedback/tracker.js';
import { makeOutgoingRefKey } from '../feedback/types.js';
import type { ToolMediaAttachment } from '../tools/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { assertNever } from '../util/assert-never.js';
import { errorFields, log } from '../util/logger.js';
import {
  createTypingTracker,
  isTransientStatus,
  parseRetryAfterMs,
  ReconnectGuard,
  runWithRetries,
  ShortLivedDedupeCache,
} from './reliability.js';
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

const WsEnvelopeSchema = z
  .object({
    source: z.string().optional(),
    sourceNumber: z.string().optional(),
    timestamp: z.number().optional(),
    dataMessage: z
      .object({
        message: z.string().optional(),
        groupInfo: z.object({ groupId: z.string().optional() }).passthrough().optional(),
        timestamp: z.number().optional(),
        attachments: z.array(z.object({}).passthrough()).optional(),
        reaction: z
          .object({
            emoji: z.string().optional(),
            remove: z.boolean().optional(),
            targetAuthor: z.string().optional(),
            targetSentTimestamp: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const WsMessageSchema = z
  .object({
    envelope: WsEnvelopeSchema.optional(),
  })
  .passthrough();

const wsLogger = log.child({ component: 'signal' });

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
  opts?: { media?: readonly ToolMediaAttachment[] | undefined } | undefined,
): Promise<number | undefined> => {
  const media = opts?.media ?? [];
  const maxBytes = 12 * 1024 * 1024;
  const base64_attachments =
    media.length > 0
      ? media
          .filter((m) => m.bytes.byteLength > 0 && m.bytes.byteLength <= maxBytes)
          .slice(0, 4)
          .map((m) => ({
            filename: m.fileName ?? 'attachment',
            contentType: m.mime || 'application/octet-stream',
            base64: Buffer.from(m.bytes).toString('base64'),
          }))
      : undefined;

  const body = {
    message: text,
    number: cfg.number,
    recipients: [recipient],
    ...(base64_attachments?.length ? { base64_attachments } : {}),
  };
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
  const env = process.env as NodeJS.ProcessEnv & { OPENHOMIE_SIGNAL_TYPING?: string };
  return (env.OPENHOMIE_SIGNAL_TYPING ?? '').trim() === '1';
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

const typingTracker = createTypingTracker(10_000);

export interface RunSignalAdapterOptions {
  config: OpenhomieConfig;
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
  _config: OpenhomieConfig,
  engine: TurnEngine,
  feedback?: FeedbackTracker | undefined,
  signal?: AbortSignal | undefined,
  dedupe?: ShortLivedDedupeCache | undefined,
): Promise<void> => {
  try {
    if (typeof raw !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (_parseErr) {
      return;
    }
    const res = WsMessageSchema.safeParse(json);
    if (!res.success) {
      wsLogger.debug('handleWsMessage.invalid', { error: res.error.message });
      return;
    }
    const envelope = res.data.envelope as SignalEnvelope | undefined;
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
      const releaseTyping = showTyping
        ? typingTracker.acquire(source, () => void sendSignalTypingIndicator(sigCfg, source, true))
        : undefined;
      try {
        const out = await engine.handleIncomingMessage(msg);
        const recipient = groupId ?? source;

        switch (out.kind) {
          case 'send_text': {
            const sentAt = Date.now();
            const media = out.media ?? [];
            const textToSend =
              out.text || (media[0]?.altText ? String(media[0].altText).trim().slice(0, 900) : '');
            const tsSent =
              (await sendSignalMessage(sigCfg, recipient, textToSend, { media })) ?? sentAt;
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
              text: textToSend,
              messageType: 'reactive',
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
        const result = releaseTyping?.();
        if (result?.fullyReleased) {
          await sendSignalTypingIndicator(sigCfg, source, false);
        }
      }
    };

    await run();
  } catch (err) {
    log.child({ component: 'signal' }).error('handler.error', errorFields(err));
  }
};

export { handleWsMessage as handleSignalWsMessageForTest };
