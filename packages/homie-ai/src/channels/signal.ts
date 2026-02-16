import type { AgentRuntime } from '../agent/runtime.js';
import type { IncomingMessage } from '../agent/types.js';
import { randomDelayMs } from '../behavior/timing.js';
import type { HomieConfig } from '../config/types.js';
import { asChatId, asMessageId } from '../types/ids.js';

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
): Promise<void> => {
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
    process.stderr.write(`Signal reaction failed: HTTP ${res.status} ${detail}\n`);
  }
};

export interface RunSignalAdapterOptions {
  config: HomieConfig;
  runtime: AgentRuntime;
  env?: NodeJS.ProcessEnv;
}

export const runSignalAdapter = async ({
  config,
  runtime,
  env,
}: RunSignalAdapterOptions): Promise<void> => {
  const sigCfg = resolveSignalConfig(env ?? process.env);
  const wsUrl = `${sigCfg.apiUrl.replace(/^http/u, 'ws')}/v1/receive/${sigCfg.number}`;

  const connect = (): void => {
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      process.stdout.write('[signal] connected\n');
    });

    ws.addEventListener('message', (ev) => {
      void handleWsMessage(ev.data, sigCfg, config, runtime);
    });

    ws.addEventListener('close', () => {
      process.stdout.write('[signal] disconnected, reconnecting in 5s\n');
      setTimeout(connect, 5_000);
    });

    ws.addEventListener('error', (err) => {
      process.stderr.write(`[signal] ws error: ${String(err)}\n`);
    });
  };

  connect();

  // Keep alive forever.
  await new Promise<never>(() => {});
};

const handleWsMessage = async (
  raw: unknown,
  sigCfg: SignalConfig,
  config: HomieConfig,
  runtime: AgentRuntime,
): Promise<void> => {
  try {
    const data =
      typeof raw === 'string' ? (JSON.parse(raw) as { envelope?: SignalEnvelope }) : null;
    const envelope = data?.envelope;
    if (!envelope) return;

    const text = envelope.dataMessage?.message?.trim();
    if (!text) return;

    const source = envelope.sourceNumber ?? envelope.source ?? '';
    const groupId = envelope.dataMessage?.groupInfo?.groupId;
    const isGroup = !!groupId;
    const chatId = asChatId(groupId ?? source);
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

    const out = await runtime.handleIncomingMessage(msg);
    if (!out?.text) return;

    const delay = randomDelayMs(config.behavior.minDelayMs, config.behavior.maxDelayMs);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    const recipient = groupId ?? source;
    await sendSignalMessage(sigCfg, recipient, out.text);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[signal] error: ${errMsg}\n`);
  }
};

export { sendSignalMessage, sendSignalReaction };
