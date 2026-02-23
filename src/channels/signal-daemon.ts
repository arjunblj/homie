import { z } from 'zod';

import type { IncomingMessage } from '../agent/types.js';
import type { OpenhomieConfig } from '../config/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import type { FeedbackTracker } from '../feedback/tracker.js';
import { makeOutgoingRefKey } from '../feedback/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { assertNever } from '../util/assert-never.js';
import { errorFields, log } from '../util/logger.js';
import {
  computeBackoffDelayMs,
  isTransientStatus,
  parseRetryAfterMs,
  runWithRetries,
  ShortLivedDedupeCache,
} from './reliability.js';
import { parseSignalAttachments, type SignalDataMessageAttachment } from './signal-shared.js';

export interface SignalDaemonConfig {
  httpUrl: string; // e.g. http://127.0.0.1:8080
  account?: string | undefined; // optional; used for multi-account mode
  operatorNumber?: string | undefined;
  receiveMode?: 'on-start' | 'manual' | undefined;
}

type SignalEnv = NodeJS.ProcessEnv & {
  SIGNAL_DAEMON_URL?: string | undefined;
  SIGNAL_HTTP_URL?: string | undefined;
  SIGNAL_RECEIVE_MODE?: string | undefined;
  SIGNAL_NUMBER?: string | undefined;
  SIGNAL_OPERATOR_NUMBER?: string | undefined;
};

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown> | undefined;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: string;
  result?: unknown;
  error?: { code?: number; message?: string } | undefined;
}

type SignalEnvelope = {
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
};

const resolveSignalDaemonConfig = (env: SignalEnv): SignalDaemonConfig => {
  const httpUrl = env.SIGNAL_DAEMON_URL?.trim() ?? env.SIGNAL_HTTP_URL?.trim();
  if (!httpUrl) throw new Error('Signal daemon adapter requires SIGNAL_DAEMON_URL.');
  const receiveModeRaw = env.SIGNAL_RECEIVE_MODE?.trim().toLowerCase();
  const receiveMode =
    receiveModeRaw === 'manual' || receiveModeRaw === 'on-start' ? receiveModeRaw : undefined;
  return {
    httpUrl: httpUrl.replace(/\/+$/u, ''),
    account: env.SIGNAL_NUMBER?.trim() || undefined,
    operatorNumber: env.SIGNAL_OPERATOR_NUMBER?.trim() || undefined,
    receiveMode,
  };
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

const backoffMs = (attempt: number): number =>
  computeBackoffDelayMs(attempt, {
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
    minDelayMs: 500,
    jitterFraction: 0.1,
  });

interface RetryableDaemonError extends Error {
  retryable?: boolean;
  retryAfterMs?: number | undefined;
}

const makeDaemonError = (
  message: string,
  retryable: boolean,
  retryAfterMs?: number | undefined,
): RetryableDaemonError => {
  const err = new Error(message) as RetryableDaemonError;
  err.retryable = retryable;
  err.retryAfterMs = retryAfterMs;
  return err;
};

const sseEvents = async function* (res: Response): AsyncGenerator<string, void, void> {
  const body = res.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx < 0) break;
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      // Collect data: lines for one SSE event.
      const dataLines = chunk
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice('data:'.length).trim());

      if (!dataLines.length) continue;
      yield dataLines.join('\n');
    }
  }
};

const rpcCall = async (
  cfg: SignalDaemonConfig,
  method: string,
  params?: Record<string, unknown>,
  opts?: { requestId?: string | undefined; idempotencyKey?: string | undefined },
): Promise<unknown> => {
  const id = opts?.requestId ?? `${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  let res: Response;
  try {
    res = await fetch(`${cfg.httpUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts?.idempotencyKey ? { 'X-Idempotency-Key': opts.idempotencyKey } : {}),
      },
      body: JSON.stringify(req),
    });
  } catch (err) {
    throw makeDaemonError(
      `Signal JSON-RPC failed: network ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw makeDaemonError(
      `Signal JSON-RPC failed: HTTP ${res.status} ${detail}`,
      isTransientStatus(res.status),
      parseRetryAfterMs(res.headers.get('retry-after'), 1000),
    );
  }
  const body = (await res.json()) as JsonRpcResponse;
  if (body.error) {
    throw makeDaemonError(
      `Signal JSON-RPC error: ${body.error.code ?? ''} ${body.error.message ?? ''}`,
      false,
    );
  }
  return body.result;
};

const sendSignalDaemonMessage = async (
  cfg: SignalDaemonConfig,
  recipient: { kind: 'dm'; number: string } | { kind: 'group'; groupId: string },
  text: string,
  account?: string | undefined,
): Promise<number | undefined> => {
  const params: Record<string, unknown> & { account?: string | undefined } =
    recipient.kind === 'group'
      ? { groupId: recipient.groupId, message: text }
      : { recipient: [recipient.number], message: text };
  if (account) params.account = account;
  const requestId = `send:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const idempotencyKey = `sigd:${recipient.kind}:${account ?? cfg.account ?? ''}:${requestId}`;
  const sendOnce = async (): Promise<number | undefined> => {
    const result = await rpcCall(cfg, 'send', params, { requestId, idempotencyKey });
    if (typeof result === 'number') return result;
    if (result && typeof result === 'object' && 'timestamp' in result) {
      const ts = (result as { timestamp?: unknown }).timestamp;
      if (typeof ts === 'number') return ts;
    }
    return undefined;
  };

  return await runWithRetries(sendOnce, {
    maxAttempts: 4,
    baseDelayMs: 1000,
    maxDelayMs: 15_000,
    minDelayMs: 500,
    jitterFraction: 0.1,
    shouldRetry: (err) => Boolean((err as RetryableDaemonError | undefined)?.retryable),
    computeRetryDelayMs: (err, computedMs) =>
      Math.max(
        computedMs,
        Math.max(0, Math.floor((err as RetryableDaemonError | undefined)?.retryAfterMs ?? 0)),
      ),
  });
};

export const sendSignalDaemonTextFromEnv = async (
  env: NodeJS.ProcessEnv,
  chatId: string,
  text: string,
): Promise<number | undefined> => {
  const cfg = resolveSignalDaemonConfig(env);
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (chatId.startsWith('signal:group:')) {
    const groupId = chatId.slice('signal:group:'.length);
    if (!groupId) return undefined;
    return await sendSignalDaemonMessage(cfg, { kind: 'group', groupId }, trimmed, cfg.account);
  }
  if (chatId.startsWith('signal:dm:')) {
    const number = chatId.slice('signal:dm:'.length);
    if (!number) return undefined;
    return await sendSignalDaemonMessage(cfg, { kind: 'dm', number }, trimmed, cfg.account);
  }
  return undefined;
};

const sendSignalDaemonReaction = async (
  cfg: SignalDaemonConfig,
  target: { kind: 'dm'; number: string } | { kind: 'group'; groupId: string },
  emoji: string,
  targetAuthor: string,
  messageId: number,
  account?: string | undefined,
): Promise<void> => {
  const params: Record<string, unknown> & { account?: string | undefined } = {
    emoji,
    targetAuthor,
    messageId,
    remove: false,
    ...(target.kind === 'group' ? { groupId: target.groupId } : { recipient: target.number }),
  };
  if (account) params.account = account;
  try {
    await rpcCall(cfg, 'sendReaction', params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.child({ component: 'signal_daemon' }).warn('reaction.failed', { errMsg: msg });
  }
};

const SignalEnvelopeSchema = z
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

const NotificationParamsSchema = z
  .object({
    envelope: SignalEnvelopeSchema.optional(),
    account: z.string().optional(),
    result: z
      .object({
        envelope: SignalEnvelopeSchema.optional(),
        account: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const JsonRpcNotificationSchema = z
  .object({
    method: z.string().optional(),
    params: NotificationParamsSchema.optional(),
  })
  .passthrough();

const notificationLogger = log.child({ component: 'signal_daemon' });

const parseNotification = (
  raw: string,
): { envelope: SignalEnvelope; account?: string | undefined } | null => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (_parseErr) {
    return null;
  }
  const res = JsonRpcNotificationSchema.safeParse(json);
  if (!res.success) {
    notificationLogger.debug('parseNotification.invalid', { error: res.error.message });
    return null;
  }
  const n = res.data;
  if (n.method !== 'receive') return null;

  const params = n.params ?? {};
  const envelope = params.envelope ?? params.result?.envelope;
  if (!envelope) return null;

  const account = params.account ?? params.result?.account;
  return { envelope: envelope as SignalEnvelope, account };
};

export interface RunSignalDaemonAdapterOptions {
  config: OpenhomieConfig;
  engine: TurnEngine;
  feedback?: FeedbackTracker | undefined;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
}

export const runSignalDaemonAdapter = async ({
  config,
  engine,
  feedback,
  env,
  signal,
}: RunSignalDaemonAdapterOptions): Promise<void> => {
  const logger = log.child({ component: 'signal_daemon' });
  const sigCfg = resolveSignalDaemonConfig(env ?? process.env);
  const incomingDedupe = new ShortLivedDedupeCache({ ttlMs: 120_000, maxEntries: 20_000 });
  if (signal?.aborted) return;

  if (sigCfg.receiveMode === 'manual') {
    try {
      await rpcCall(
        sigCfg,
        'subscribeReceive',
        sigCfg.account ? { account: sigCfg.account } : undefined,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('subscribeReceive.failed', { errMsg: msg });
    }
  }

  let attempt = 0;
  while (true) {
    if (signal?.aborted) return;
    try {
      const res = await fetch(`${sigCfg.httpUrl}/api/v1/events`, {
        ...(signal ? { signal } : {}),
        headers: { Accept: 'text/event-stream' },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`SSE HTTP ${res.status} ${detail}`);
      }

      logger.info('connected');
      attempt = 0;

      for await (const data of sseEvents(res)) {
        if (signal?.aborted) return;
        void handleEvent(data, sigCfg, config, engine, feedback, signal, incomingDedupe);
      }

      throw new Error('SSE stream ended');
    } catch (err) {
      if (signal?.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      const wait = backoffMs(attempt);
      logger.warn('disconnected.reconnecting', { errMsg: msg, waitMs: wait });
      await sleep(wait);
      attempt += 1;
    }
  }
};

const handleEvent = async (
  data: string,
  sigCfg: SignalDaemonConfig,
  _config: OpenhomieConfig,
  engine: TurnEngine,
  feedback?: FeedbackTracker | undefined,
  signal?: AbortSignal | undefined,
  dedupe?: ShortLivedDedupeCache | undefined,
): Promise<void> => {
  const parsed = parseNotification(data);
  if (!parsed) return;

  const envelope = parsed.envelope;
  const account = parsed.account ?? sigCfg.account;

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
    try {
      const out = await engine.handleIncomingMessage(msg);
      const target = isGroup
        ? ({ kind: 'group', groupId: groupId as string } as const)
        : ({ kind: 'dm', number: source } as const);

      switch (out.kind) {
        case 'send_text': {
          const sentAt = Date.now();
          const tsSent =
            (await sendSignalDaemonMessage(sigCfg, target, out.text, account)) ?? sentAt;
          feedback?.onOutgoingSent({
            channel: 'signal',
            chatId,
            refKey: makeOutgoingRefKey(chatId, {
              channel: 'signal',
              targetAuthor: account ?? sigCfg.account ?? '',
              targetTimestampMs: tsSent,
            }),
            isGroup,
            sentAtMs: tsSent,
            text: out.text,
            messageType: 'reactive',
            primaryChannelUserId: `${msg.channel}:${msg.authorId}`,
          });
          break;
        }
        case 'react': {
          await sendSignalDaemonReaction(
            sigCfg,
            target,
            out.emoji,
            out.targetAuthorId,
            out.targetTimestampMs,
            account,
          );
          break;
        }
        case 'silence':
          break;
        default:
          assertNever(out);
      }
    } catch (err) {
      log.child({ component: 'signal_daemon' }).error('handler.error', errorFields(err));
    }
  };

  await run();
};

export { handleEvent as handleSignalDaemonEventForTest };
