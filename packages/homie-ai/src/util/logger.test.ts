import { describe, expect, test } from 'bun:test';

import { createLogger } from './logger.js';

describe('logger redaction', () => {
  test('redacts common secret keys and patterns', () => {
    const originalWrite = process.stderr.write;
    const lines: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test helper to capture output
    (process.stderr as any).write = (chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    };

    try {
      const logger = createLogger({ app: 'test' }, 'debug');
      logger.info('hello', {
        api_key: 'sk-1234567890123456789012345',
        authorization: 'Bearer supersecret',
        note: 'Bearer also-should-redact',
        freeText: 'here is sk-abcdefghijklmnopqrstuvwxyz123456',
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    const last = lines.filter(Boolean).at(-1);
    if (!last) throw new Error('Expected a log line');
    const entry = JSON.parse(last) as {
      api_key?: unknown;
      authorization?: unknown;
      note?: unknown;
      freeText?: unknown;
    };

    expect(entry.api_key).toBe('[REDACTED]');
    expect(entry.authorization).toBe('[REDACTED]');
    expect(entry.note).toBe('Bearer [REDACTED]');
    expect(String(entry.freeText)).toContain('sk-[REDACTED]');
  });

  test('does not throw on circular contexts', () => {
    const originalWrite = process.stderr.write;
    const lines: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test helper to capture output
    (process.stderr as any).write = (chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    };

    try {
      const logger = createLogger({ app: 'test' }, 'debug');
      const obj: { a: number; self?: unknown } = { a: 1 };
      obj.self = obj;
      logger.info('circular', { obj });
    } finally {
      process.stderr.write = originalWrite;
    }

    const last = lines.filter(Boolean).at(-1);
    if (!last) throw new Error('Expected a log line');
    const entry = JSON.parse(last) as { obj?: unknown };
    expect(entry.obj).toBeTruthy();
    expect(JSON.stringify(entry.obj)).toContain('[Circular]');
  });
});
