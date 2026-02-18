import { PerKeyLock } from '../agent/lock.js';
import type { IncomingMessage } from '../agent/types.js';
import { randomDelayMs } from '../behavior/timing.js';
import type { HomieConfig } from '../config/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import type { FeedbackTracker } from '../feedback/tracker.js';
import { makeOutgoingRefKey } from '../feedback/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { assertNever } from '../util/assert-never.js';
import { errorFields, log } from '../util/logger.js';
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

const sendSignalMessage = async (
  cfg: SignalConfig,
  recipient: string,
  text: string,
): Promise<number | undefined> => {
  const body = { message: text, number: cfg.number, recipients: [recipient] };
  const res = await fetch(`${cfg.apiUrl}/v2/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Signal send failed: HTTP ${res.status} ${detail}`);
  }
  try {
    const json = (await res.json()) as { timestamp?: number } | undefined;
    return typeof json?.timestamp === 'number' ? json.timestamp : undefined;
  } catch (err) {
    void err;
    return undefined;
  }
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

// biome-ignore lint/complexity/useLiteralKeys: TS settings require bracket access for process.env.
const typingEnabled = (): boolean => (process.env['HOMIE_SIGNAL_TYPING'] ?? '').trim() === '1';

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
  const chatQueue = new PerKeyLock<string>();

  const connect = (): void => {
    if (signal?.aborted) return;
    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.addEventListener('open', () => {
      logger.info('connected');
    });

    socket.addEventListener('message', (ev) => {
      void handleWsMessage(ev.data, sigCfg, config, engine, feedback, chatQueue, signal);
    });

    socket.addEventListener('close', () => {
      if (signal?.aborted) return;
      logger.warn('disconnected.reconnecting', { waitMs: 5_000 });
      setTimeout(() => {
        if (signal?.aborted) return;
        connect();
      }, 5_000);
    });

    socket.addEventListener('error', (err) => {
      logger.error('ws.error', { errMsg: String(err) });
    });
  };

  connect();

  if (signal) {
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
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
  config: HomieConfig,
  engine: TurnEngine,
  feedback?: FeedbackTracker | undefined,
  chatQueue?: PerKeyLock<string> | undefined,
  signal?: AbortSignal | undefined,
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
    const chatKey = String(chatId);
    const ts = envelope.dataMessage?.timestamp ?? envelope.timestamp ?? Date.now();
    const isOperator = source === sigCfg.operatorNumber;

    const reaction = envelope.dataMessage?.reaction;
    const emoji = reaction?.emoji?.trim();
    const targetAuthor = reaction?.targetAuthor?.trim();
    const targetSentTimestamp = reaction?.targetSentTimestamp;
    if (emoji && targetAuthor && typeof targetSentTimestamp === 'number') {
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

      if (chatQueue) await chatQueue.runExclusive(chatKey, run);
      else await run();
      return;
    }

    const attachments = parseSignalAttachments(envelope.dataMessage?.attachments ?? [], ts);

    const text = envelope.dataMessage?.message?.trim() ?? '';
    if (!text && (!attachments || attachments.length === 0)) return;

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
      let typingTimer: ReturnType<typeof setInterval> | undefined;
      try {
        if (showTyping) {
          const tick = (): void => void sendSignalTypingIndicator(sigCfg, source, true);
          tick();
          typingTimer = setInterval(tick, 10_000);
        }

        const out = await engine.handleIncomingMessage(msg);
        const recipient = groupId ?? source;

        switch (out.kind) {
          case 'send_text': {
            const delay = randomDelayMs(config.behavior.minDelayMs, config.behavior.maxDelayMs);
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
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
          case 'send_audio': {
            // Fallback: this adapter doesn't support audio sending yet.
            const delay = randomDelayMs(config.behavior.minDelayMs, config.behavior.maxDelayMs);
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
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
            const delay = randomDelayMs(config.behavior.minDelayMs, config.behavior.maxDelayMs);
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
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
        if (typingTimer) clearInterval(typingTimer);
        if (showTyping) await sendSignalTypingIndicator(sigCfg, source, false);
      }
    };

    if (chatQueue) await chatQueue.runExclusive(chatKey, run);
    else await run();
  } catch (err) {
    log.child({ component: 'signal' }).error('handler.error', errorFields(err));
  }
};

export { sendSignalMessage, sendSignalReaction };
