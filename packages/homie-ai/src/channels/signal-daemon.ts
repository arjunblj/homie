import type { IncomingMessage } from '../agent/types.js';
import { randomDelayMs } from '../behavior/timing.js';
import type { HomieConfig } from '../config/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { assertNever } from '../util/assert-never.js';

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

interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method?: string;
  params?: unknown;
}

type SignalEnvelope = {
  source?: string;
  sourceNumber?: string;
  timestamp?: number;
  dataMessage?: {
    message?: string;
    groupInfo?: { groupId?: string };
    timestamp?: number;
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

const backoffMs = (attempt: number): number => {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
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
): Promise<unknown> => {
  const id = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  const res = await fetch(`${cfg.httpUrl}/api/v1/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Signal JSON-RPC failed: HTTP ${res.status} ${detail}`);
  }
  const body = (await res.json()) as JsonRpcResponse;
  if (body.error) {
    throw new Error(`Signal JSON-RPC error: ${body.error.code ?? ''} ${body.error.message ?? ''}`);
  }
  return body.result;
};

const sendSignalDaemonMessage = async (
  cfg: SignalDaemonConfig,
  recipient: { kind: 'dm'; number: string } | { kind: 'group'; groupId: string },
  text: string,
  account?: string | undefined,
): Promise<void> => {
  const params: Record<string, unknown> & { account?: string | undefined } =
    recipient.kind === 'group'
      ? { groupId: recipient.groupId, message: text }
      : { recipient: [recipient.number], message: text };
  if (account) params.account = account;
  await rpcCall(cfg, 'send', params);
};

export const sendSignalDaemonTextFromEnv = async (
  env: NodeJS.ProcessEnv,
  chatId: string,
  text: string,
): Promise<void> => {
  const cfg = resolveSignalDaemonConfig(env);
  const trimmed = text.trim();
  if (!trimmed) return;

  if (chatId.startsWith('signal:group:')) {
    const groupId = chatId.slice('signal:group:'.length);
    if (!groupId) return;
    await sendSignalDaemonMessage(cfg, { kind: 'group', groupId }, trimmed, cfg.account);
    return;
  }
  if (chatId.startsWith('signal:dm:')) {
    const number = chatId.slice('signal:dm:'.length);
    if (!number) return;
    await sendSignalDaemonMessage(cfg, { kind: 'dm', number }, trimmed, cfg.account);
  }
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
    process.stderr.write(`[signal] reaction failed: ${msg}\n`);
  }
};

const parseNotification = (
  raw: string,
): { envelope: SignalEnvelope; account?: string | undefined } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (_parseErr) {
    return null;
  }
  const n = parsed as JsonRpcNotification;
  if (n.method !== 'receive') return null;

  const params = (n.params ?? {}) as Record<string, unknown> & {
    envelope?: unknown;
    account?: unknown;
    result?: unknown;
  };
  const result = params.result as { envelope?: unknown; account?: unknown } | undefined;
  const envelope =
    (params.envelope as SignalEnvelope | undefined) ??
    (result?.envelope as SignalEnvelope | undefined);
  if (!envelope) return null;

  const account = (params.account as string | undefined) ?? (result?.account as string | undefined);
  return { envelope, account };
};

export interface RunSignalDaemonAdapterOptions {
  config: HomieConfig;
  engine: TurnEngine;
  env?: NodeJS.ProcessEnv;
}

export const runSignalDaemonAdapter = async ({
  config,
  engine,
  env,
}: RunSignalDaemonAdapterOptions): Promise<void> => {
  const sigCfg = resolveSignalDaemonConfig(env ?? process.env);

  if (sigCfg.receiveMode === 'manual') {
    try {
      await rpcCall(
        sigCfg,
        'subscribeReceive',
        sigCfg.account ? { account: sigCfg.account } : undefined,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[signal] subscribeReceive failed: ${msg}\n`);
    }
  }

  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(`${sigCfg.httpUrl}/api/v1/events`, {
        headers: { Accept: 'text/event-stream' },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`SSE HTTP ${res.status} ${detail}`);
      }

      process.stdout.write('[signal] connected (daemon)\n');
      attempt = 0;

      for await (const data of sseEvents(res)) {
        void handleEvent(data, sigCfg, config, engine);
      }

      throw new Error('SSE stream ended');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const wait = backoffMs(attempt);
      process.stderr.write(`[signal] disconnected: ${msg} (reconnecting in ${wait}ms)\n`);
      await sleep(wait);
      attempt += 1;
    }
  }
};

const handleEvent = async (
  data: string,
  sigCfg: SignalDaemonConfig,
  config: HomieConfig,
  engine: TurnEngine,
): Promise<void> => {
  const parsed = parseNotification(data);
  if (!parsed) return;

  const envelope = parsed.envelope;
  const account = parsed.account ?? sigCfg.account;

  const text = envelope.dataMessage?.message?.trim();
  if (!text) return;

  const source = envelope.sourceNumber ?? envelope.source ?? '';
  const groupId = envelope.dataMessage?.groupInfo?.groupId;
  const isGroup = !!groupId;
  const chatId = asChatId(groupId ? `signal:group:${groupId}` : `signal:dm:${source}`);
  const ts = envelope.dataMessage?.timestamp ?? envelope.timestamp ?? Date.now();
  const isOperator = source === sigCfg.operatorNumber;

  const msg: IncomingMessage = {
    channel: 'signal',
    chatId,
    messageId: asMessageId(`signal:${ts}`),
    authorId: source,
    text,
    isGroup,
    isOperator,
    timestampMs: ts,
  };

  try {
    const out = await engine.handleIncomingMessage(msg);
    const target = isGroup
      ? ({ kind: 'group', groupId: groupId as string } as const)
      : ({ kind: 'dm', number: source } as const);

    switch (out.kind) {
      case 'send_text': {
        const delay = randomDelayMs(config.behavior.minDelayMs, config.behavior.maxDelayMs);
        if (delay > 0) await sleep(delay);
        await sendSignalDaemonMessage(sigCfg, target, out.text, account);
        break;
      }
      case 'react': {
        const delay = randomDelayMs(config.behavior.minDelayMs, config.behavior.maxDelayMs);
        if (delay > 0) await sleep(delay);
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
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[signal] error: ${errMsg}\n`);
  }
};
