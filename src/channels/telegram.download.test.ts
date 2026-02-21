import { describe, expect, test } from 'bun:test';

import { downloadTelegramBytes, parseRetryAfterMs, redactTelegramToken } from './telegram.js';

describe('telegram download hardening', () => {
  test('redacts bot token in error text', () => {
    const token = '12345:ABCDEF_secret';
    const input = `https://api.telegram.org/file/bot${token}/x`;
    const out = redactTelegramToken(input, token);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED_TELEGRAM_TOKEN]');
  });

  test('parses retry-after seconds to milliseconds', () => {
    expect(parseRetryAfterMs('2', 1000)).toBe(2000);
    expect(parseRetryAfterMs(undefined, 1000)).toBe(1000);
  });

  test('retries on 429 and succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    const bytes = await downloadTelegramBytes({
      url: 'https://api.telegram.org/file/botTOKEN/path',
      token: 'TOKEN',
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '1' },
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(calls).toBe(2);
    expect(waits[0]).toBe(1000);
  });

  test('network-error path redacts token-bearing URL in errors', async () => {
    await expect(
      downloadTelegramBytes({
        url: 'https://api.telegram.org/file/botSUPER_SECRET_TOKEN/path',
        token: 'SUPER_SECRET_TOKEN',
        fetchImpl: (async (url: string | URL | Request) => {
          throw new Error(`request to ${String(url)} aborted`);
        }) as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow('[REDACTED_TELEGRAM_TOKEN]');
  });
});
