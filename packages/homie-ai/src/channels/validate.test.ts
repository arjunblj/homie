import { afterEach, describe, expect, test } from 'bun:test';
import {
  sendTelegramTestMessage,
  tryFetchSignalLinkUri,
  validateTelegramToken,
  verifySignalDaemonHealth,
} from './validate.js';

describe('validateTelegramToken', () => {
  const originalFetch = globalThis.fetch;
  const validToken = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd1234';

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns ok with valid token', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: { username: 'testbot' } }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await validateTelegramToken(validToken);
    expect(result).toEqual({ ok: true, username: 'testbot' });
  });

  test('returns error for empty token', async () => {
    const result = await validateTelegramToken('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('empty');
  });

  test('returns error for malformed token', async () => {
    const result = await validateTelegramToken('123:ABC');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('format');
  });
});

describe('verifySignalDaemonHealth', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns healthy when API responds', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

    const result = await verifySignalDaemonHealth('http://127.0.0.1:8080');
    expect(result).toEqual({ ok: true });
  });

  test('returns unhealthy on network error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await verifySignalDaemonHealth('http://127.0.0.1:8080');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('ECONNREFUSED');
  });

  test('fails fast on invalid daemon URL', async () => {
    const result = await verifySignalDaemonHealth('file:///tmp/signal');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('invalid');
  });
});

describe('sendTelegramTestMessage', () => {
  const originalFetch = globalThis.fetch;
  const validToken = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd1234';

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns ok when Telegram send succeeds', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

    const result = await sendTelegramTestMessage(validToken, '42');
    expect(result).toEqual({ ok: true });
  });

  test('returns error when Telegram send fails', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
        status: 400,
      })) as unknown as typeof fetch;

    const result = await sendTelegramTestMessage(validToken, '42');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('chat not found');
  });

  test('fails fast for malformed token without network call', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await sendTelegramTestMessage('bad', '42');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('format');
    expect(called).toBeFalse();
  });
});

describe('tryFetchSignalLinkUri', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns uri from JSON response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ uri: 'sgnl://link' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const uri = await tryFetchSignalLinkUri('http://127.0.0.1:8080');
    expect(uri).toBe('sgnl://link');
  });

  test('falls back to text response parsing', async () => {
    let callCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      callCount += 1;
      const url = String(input);
      if (url.includes('device_name=homie')) {
        return new Response('not-a-link', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      return new Response('sgnl://fallback-link', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }) as unknown as typeof fetch;

    const uri = await tryFetchSignalLinkUri('http://127.0.0.1:8080');
    expect(callCount).toBe(2);
    expect(uri).toBe('sgnl://fallback-link');
  });

  test('returns null when no probe returns a Signal URI', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ uri: 'https://example.com/not-signal' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const uri = await tryFetchSignalLinkUri('http://127.0.0.1:8080');
    expect(uri).toBeNull();
  });

  test('returns null for invalid daemon URL', async () => {
    const uri = await tryFetchSignalLinkUri('://bad');
    expect(uri).toBeNull();
  });
});
