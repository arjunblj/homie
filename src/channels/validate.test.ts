import { describe, expect, test } from 'bun:test';
import { withMockFetch } from '../testing/mockFetch.js';
import {
  configureTelegramBotProfile,
  sendTelegramTestMessage,
  tryFetchSignalLinkUri,
  validateTelegramToken,
  verifySignalDaemonHealth,
} from './validate.js';

describe('validateTelegramToken', () => {
  const validToken = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd1234';

  test('returns ok with valid token', async () => {
    await withMockFetch(
      (async () =>
        new Response(JSON.stringify({ ok: true, result: { username: 'testbot' } }), {
          status: 200,
        })) as unknown as typeof fetch,
      async () => {
        const result = await validateTelegramToken(validToken);
        expect(result).toEqual({ ok: true, username: 'testbot' });
      },
    );
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
  test('returns healthy when API responds', async () => {
    await withMockFetch(
      (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      async () => {
        const result = await verifySignalDaemonHealth('http://127.0.0.1:8080');
        expect(result).toEqual({ ok: true });
      },
    );
  });

  test('returns unhealthy on network error', async () => {
    await withMockFetch(
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
      async () => {
        const result = await verifySignalDaemonHealth('http://127.0.0.1:8080');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('ECONNREFUSED');
      },
    );
  });

  test('fails fast on invalid daemon URL', async () => {
    const result = await verifySignalDaemonHealth('file:///tmp/signal');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('invalid');
  });
});

describe('sendTelegramTestMessage', () => {
  const validToken = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd1234';

  test('returns ok when Telegram send succeeds', async () => {
    await withMockFetch(
      (async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
      async () => {
        const result = await sendTelegramTestMessage(validToken, '42');
        expect(result).toEqual({ ok: true });
      },
    );
  });

  test('returns error when Telegram send fails', async () => {
    await withMockFetch(
      (async () =>
        new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
          status: 400,
        })) as unknown as typeof fetch,
      async () => {
        const result = await sendTelegramTestMessage(validToken, '42');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('chat not found');
      },
    );
  });

  test('fails fast for malformed token without network call', async () => {
    let called = false;
    await withMockFetch(
      (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      async () => {
        const result = await sendTelegramTestMessage('bad', '42');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('format');
        expect(called).toBeFalse();
      },
    );
  });
});

describe('configureTelegramBotProfile', () => {
  const validToken = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd1234';

  test('fails fast for malformed token without network call', async () => {
    let called = false;
    await withMockFetch(
      (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      async () => {
        const result = await configureTelegramBotProfile({
          token: 'bad-token',
          name: 'Homie',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('format');
        expect(called).toBeFalse();
      },
    );
  });

  test('normalizes and caps fields before sending', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    await withMockFetch(
      (async (input: RequestInfo | URL, init?: RequestInit | undefined) => {
        const url = String(input);
        const method = url.split('/').slice(-1)[0] ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ method, body });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch,
      async () => {
        const result = await configureTelegramBotProfile({
          token: validToken,
          name: `A${'b'.repeat(100)}\nline2`,
          description: `x${' y'.repeat(800)}\n\nz`,
          shortDescription: `s${' t'.repeat(400)}\nzz`,
        });
        expect(result.ok).toBe(true);
      },
    );

    expect(calls.map((c) => c.method)).toEqual([
      'setMyName',
      'setMyDescription',
      'setMyShortDescription',
    ]);

    const name = String(calls[0]?.body['name'] ?? '');
    const desc = String(calls[1]?.body['description'] ?? '');
    const short = String(calls[2]?.body['short_description'] ?? '');

    expect(name.length).toBeLessThanOrEqual(64);
    expect(/\s{2,}/u.test(name)).toBeFalse();
    expect(name.includes('\n')).toBeFalse();

    expect(desc.length).toBeLessThanOrEqual(512);
    expect(desc.includes('\n')).toBeFalse();

    expect(short.length).toBeLessThanOrEqual(120);
    expect(short.includes('\n')).toBeFalse();
  });

  test('returns ok=false with partial failure details', async () => {
    let setNameCalled = false;
    let setDescCalled = false;
    let setShortCalled = false;

    await withMockFetch(
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/setMyName')) {
          setNameCalled = true;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith('/setMyDescription')) {
          setDescCalled = true;
          return new Response(JSON.stringify({ ok: false, description: 'bad description' }), {
            status: 400,
          });
        }
        if (url.endsWith('/setMyShortDescription')) {
          setShortCalled = true;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false, description: 'unexpected method' }), {
          status: 400,
        });
      }) as unknown as typeof fetch,
      async () => {
        const result = await configureTelegramBotProfile({
          token: validToken,
          name: 'Homie',
          description: 'desc',
          shortDescription: 'short',
        });
        expect(result.ok).toBe(false);
        expect(result.applied).toContain('name');
        expect(result.failed.some((f) => f.field === 'description')).toBeTrue();
      },
    );

    expect(setNameCalled).toBeTrue();
    expect(setDescCalled).toBeTrue();
    expect(setShortCalled).toBeTrue();
  });
});

describe('tryFetchSignalLinkUri', () => {
  test('returns uri from JSON response', async () => {
    await withMockFetch(
      (async () =>
        new Response(JSON.stringify({ uri: 'sgnl://link' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      async () => {
        const uri = await tryFetchSignalLinkUri('http://127.0.0.1:8080');
        expect(uri).toBe('sgnl://link');
      },
    );
  });

  test('falls back to text response parsing', async () => {
    let callCount = 0;
    await withMockFetch(
      (async (input: RequestInfo | URL) => {
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
      }) as unknown as typeof fetch,
      async () => {
        const uri = await tryFetchSignalLinkUri('http://127.0.0.1:8080');
        expect(callCount).toBe(2);
        expect(uri).toBe('sgnl://fallback-link');
      },
    );
  });

  test('returns null when no probe returns a Signal URI', async () => {
    await withMockFetch(
      (async () =>
        new Response(JSON.stringify({ uri: 'https://example.com/not-signal' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      async () => {
        const uri = await tryFetchSignalLinkUri('http://127.0.0.1:8080');
        expect(uri).toBeNull();
      },
    );
  });

  test('returns null for invalid daemon URL', async () => {
    const uri = await tryFetchSignalLinkUri('://bad');
    expect(uri).toBeNull();
  });
});
