import { describe, expect, test } from 'bun:test';

import { asChatId, asPersonId } from '../types/ids.js';
import { HttpMemoryStore } from './http.js';

describe('HttpMemoryStore (more)', () => {
  test('logEpisode posts to /log_episode', async () => {
    let gotUrl = '';
    let gotBody = '';
    let gotAuth = '';
    const store = new HttpMemoryStore({
      baseUrl: 'http://mem.test/',
      token: 't',
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        gotUrl = String(url);
        gotBody = String(init?.body ?? '');
        gotAuth = String(
          (
            init?.headers as
              | (Record<string, string> & { Authorization?: string | undefined })
              | undefined
          )?.Authorization ?? '',
        );
        return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await store.logEpisode({
      chatId: asChatId('c'),
      content: 'hello',
      createdAtMs: 1700000000000,
    });

    expect(gotUrl).toBe('http://mem.test/log_episode');
    expect(gotBody).toContain('"raw_content":"hello"');
    expect(gotBody).toContain('"chat_id":"c"');
    expect(gotAuth).toBe('Bearer t');
  });

  test('logLesson maps to log_lesson schema', async () => {
    let gotBody = '';
    const store = new HttpMemoryStore({
      baseUrl: 'http://mem.test',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        gotBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await store.logLesson({ category: 'x', content: 'y', createdAtMs: 1 });
    expect(gotBody).toContain('"type":"observation"');
    expect(gotBody).toContain('"what_happened":"x"');
    expect(gotBody).toContain('"the_lesson":"y"');
  });

  test('throws on non-ok response', async () => {
    const store = new HttpMemoryStore({
      baseUrl: 'http://mem.test',
      fetchImpl: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(store.getContextPack({ query: 'q', chatId: asChatId('c') })).rejects.toThrow(
      'HTTP 500',
    );
  });

  test('throws even if error body cannot be read', async () => {
    const store = new HttpMemoryStore({
      baseUrl: 'http://mem.test',
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 500,
          text: async () => {
            throw new Error('boom');
          },
          json: async () => ({}),
        }) as unknown as Response) as unknown as typeof fetch,
    });

    await expect(store.searchEpisodes('q', 1)).rejects.toThrow('HTTP 500');
  });

  test('getContextPack trims and returns context', async () => {
    let gotUrl = '';
    let gotBody = '';
    const store = new HttpMemoryStore({
      baseUrl: 'http://mem.test///',
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        gotUrl = String(url);
        gotBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ context: '  hello  ' }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const out = await store.getContextPack({
      query: 'q',
      chatId: asChatId('c'),
      channelType: 'signal',
      participants: ['a', 'b'],
      limit: 3,
      maxChars: 9,
    });

    expect(gotUrl).toBe('http://mem.test/context_pack');
    expect(gotBody).toContain('"query":"q"');
    expect(gotBody).toContain('"limit":3');
    expect(gotBody).toContain('"max_chars":9');
    expect(out.context).toBe('hello');
  });

  test('searchEpisodes maps text into Episode.content', async () => {
    const store = new HttpMemoryStore({
      baseUrl: 'http://mem.test',
      fetchImpl: (async () =>
        new Response(JSON.stringify([{ text: 'a' }, { text: 'b' }]), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    const eps = await store.searchEpisodes('q', 2);
    expect(eps.map((e) => e.content)).toEqual(['a', 'b']);
  });

  test('no-op and empty-return methods behave consistently', async () => {
    const store = new HttpMemoryStore({
      baseUrl: 'http://mem.test',
      fetchImpl: (async () =>
        new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch,
    });

    expect(await store.getPerson('x')).toBeNull();
    expect(await store.getPersonByChannelId('x')).toBeNull();
    expect(await store.searchPeople('x')).toEqual([]);
    await store.updateRelationshipStage('x', 'friend');
    await store.trackPerson({
      id: asPersonId('p'),
      displayName: 'd',
      channel: 'signal',
      channelUserId: 'signal:x',
      relationshipStage: 'new',
      createdAtMs: 0,
      updatedAtMs: 0,
    });

    expect(await store.getFacts('x')).toEqual([]);
    expect(await store.searchFacts('x', 5)).toEqual([]);
    await store.storeFact({ subject: 's', content: 'c', createdAtMs: 0 });

    expect(await store.getLessons()).toEqual([]);
    expect(await store.getRecentEpisodes(asChatId('c'), 24)).toEqual([]);
    await store.deletePerson('p');
    await store.importJson({});
    const exported = (await store.exportJson()) as { ok?: boolean };
    expect(exported.ok).toBe(false);
  });
});
