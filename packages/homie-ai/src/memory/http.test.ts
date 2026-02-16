import { describe, expect, test } from 'bun:test';

import { asChatId } from '../types/ids.js';
import { HttpMemoryStore } from './http.js';

describe('HttpMemoryStore', () => {
  test('sends bearer token to context_pack', async () => {
    let gotUrl = '';
    let gotAuth = '';
    const store = new HttpMemoryStore({
      baseUrl: 'http://example.test',
      token: 't123',
      fetchImpl: (async (url, init) => {
        gotUrl = String(url);
        gotAuth = String(
          (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '',
        );
        return new Response(JSON.stringify({ context: 'ok' }), { status: 200 });
      }) as typeof fetch,
    });

    const res = await store.getContextPack({
      query: 'hi',
      chatId: asChatId('c'),
      channelType: 'signal',
      participants: ['signal:alice'],
    });

    expect(gotUrl).toBe('http://example.test/context_pack');
    expect(gotAuth).toBe('Bearer t123');
    expect(res.context).toBe('ok');
  });
});
