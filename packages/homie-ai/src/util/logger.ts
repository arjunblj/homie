import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  fatal(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export const logContext: AsyncLocalStorage<Record<string, unknown>> = new AsyncLocalStorage<
  Record<string, unknown>
>();

export function getLogContext(): Record<string, unknown> {
  return logContext.getStore() ?? {};
}

export function withLogContext<T>(ctx: Record<string, unknown>, fn: () => T): T {
  const base = getLogContext();
  return logContext.run({ ...base, ...ctx }, fn);
}

export function newCorrelationId(): string {
  return randomUUID();
}

const SENSITIVE_KEYS = new Set(
  [
    'api_key',
    'apikey',
    'authorization',
    'cookie',
    'openai_api_key',
    'openrouter_api_key',
    'anthropic_api_key',
    'brave_api_key',
    'token',
    'x-subscription-token',
  ].map((k) => k.toLowerCase()),
);

const redactString = (input: string): string => {
  let s = input;
  // Common patterns (best-effort). Keep it minimal and avoid false positives.
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/gu, 'Bearer [REDACTED]');
  s = s.replace(/bot\d+:[A-Za-z0-9_-]+/gu, 'bot[REDACTED]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, 'sk-[REDACTED]');
  return s;
};

const redactValue = (
  value: unknown,
  _keyHint?: string,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown => {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, undefined, seen));
  if (typeof value !== 'object') return String(value);

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || lower.endsWith('_token') || lower.endsWith('_secret')) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = redactValue(v, k, seen);
  }
  return out;
};

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errName: err.name,
      errMsg: redactString(err.message),
      ...(err.cause ? { errCause: redactString(String(err.cause)) } : {}),
    };
  }
  return { errMsg: redactString(String(err)) };
}

const envLevel = (): LogLevel => {
  // biome-ignore lint/complexity/useLiteralKeys: TS settings require bracket access for process.env.
  const raw = process.env['HOMIE_LOG_LEVEL']?.trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'fatal') {
    return raw;
  }
  // Default to warn: production runs can enable info explicitly, tests stay quiet by default.
  return 'warn';
};

export function createLogger(
  base: Record<string, unknown> = {},
  threshold: LogLevel = envLevel(),
): Logger {
  const minLevel = LEVEL_VALUE[threshold];

  const emit = (level: LogLevel, msg: string, ctx?: Record<string, unknown>): void => {
    if (LEVEL_VALUE[level] < minLevel) return;
    const entry = redactValue({
      level,
      ts: new Date().toISOString(),
      msg,
      ...base,
      ...(logContext.getStore() ?? {}),
      ...(ctx ?? {}),
    }) as Record<string, unknown>;
    try {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    } catch (err) {
      const fallback = {
        level,
        ts: new Date().toISOString(),
        msg: 'logger.stringify_failed',
        originalMsg: msg,
        ...errorFields(err),
      };
      process.stderr.write(`${JSON.stringify(fallback)}\n`);
    }
  };

  return {
    debug: (msg, ctx) => emit('debug', msg, ctx),
    info: (msg, ctx) => emit('info', msg, ctx),
    warn: (msg, ctx) => emit('warn', msg, ctx),
    error: (msg, ctx) => emit('error', msg, ctx),
    fatal: (msg, ctx) => emit('fatal', msg, ctx),
    child: (bindings) => createLogger({ ...base, ...bindings }, threshold),
  };
}

export const log: Logger = createLogger({ app: 'homie-ai' });
