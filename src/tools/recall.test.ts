import { describe, expect, test } from 'bun:test';

import type { MemoryStore } from '../memory/store.js';
import type { Episode, Fact, PersonRecord } from '../memory/types.js';
import { asChatId, asPersonId } from '../types/ids.js';
import { recallTool } from './recall.js';

describe('recall tool', () => {
  test('filters episodes to current chatId (no cross-chat leakage)', async () => {
    const chatId = asChatId('tg:group:1');
    const otherChatId = asChatId('tg:group:2');

    const episodes: Episode[] = [
      { chatId, content: 'we talked about ramen', createdAtMs: 1, isGroup: true },
      { chatId: otherChatId, content: 'secret from other chat', createdAtMs: 2, isGroup: true },
    ];

    const store: Partial<MemoryStore> = {
      async hybridSearchEpisodes() {
        return episodes;
      },
      async getGroupCapsule() {
        return 'group capsule';
      },
    };

    const ctx = {
      now: new Date(),
      signal: new AbortController().signal,
      chat: {
        chatId,
        channel: 'telegram',
        channelUserId: 'telegram:alice',
        isGroup: true,
        isOperator: false,
      },
      services: { memoryStore: store as MemoryStore },
    };

    const res = await recallTool.execute({ query: 'ramen', limit: 10 }, ctx);
    expect(res).toMatchObject({
      status: 'ok',
      scope: { kind: 'group', chatId: String(chatId) },
      results: { episodes: [{ text: expect.stringContaining('ramen') }] },
    });
    expect(JSON.stringify(res)).not.toContain('secret from other chat');
  });

  test('does not include person facts in group scope', async () => {
    const chatId = asChatId('tg:group:1');
    const personId = asPersonId('person:telegram:alice');
    const facts: Fact[] = [
      { id: 1 as never, personId, subject: 'Alice', content: 'Likes cats', createdAtMs: 1 },
    ];

    const store: Partial<MemoryStore> = {
      async hybridSearchEpisodes() {
        return [];
      },
      async hybridSearchFacts() {
        return facts;
      },
      async getPersonByChannelId() {
        const p: PersonRecord = {
          id: personId,
          displayName: 'Alice',
          channel: 'telegram',
          channelUserId: 'telegram:alice',
          relationshipScore: 0,
          createdAtMs: 1,
          updatedAtMs: 1,
        };
        return p;
      },
      async getGroupCapsule() {
        return null;
      },
    };

    const ctx = {
      now: new Date(),
      signal: new AbortController().signal,
      chat: {
        chatId,
        channel: 'telegram',
        channelUserId: 'telegram:alice',
        isGroup: true,
        isOperator: false,
      },
      services: { memoryStore: store as MemoryStore },
    };

    const res = await recallTool.execute({ query: 'cats' }, ctx);
    expect(res).toMatchObject({ status: 'ok', scope: { kind: 'group' } });
    expect(JSON.stringify(res)).not.toContain('Likes cats');
  });

  test('includes person facts for DM scope when channelUserId is available', async () => {
    const chatId = asChatId('signal:dm:+1');
    const personId = asPersonId('person:signal:+1');

    const store: Partial<MemoryStore> = {
      async hybridSearchEpisodes() {
        return [{ chatId, content: 'we discussed hiking', createdAtMs: 1, isGroup: false }];
      },
      async getPersonByChannelId() {
        const p: PersonRecord = {
          id: personId,
          displayName: '+1',
          channel: 'signal',
          channelUserId: 'signal:+1',
          relationshipScore: 0,
          createdAtMs: 1,
          updatedAtMs: 1,
        };
        return p;
      },
      async hybridSearchFacts() {
        return [
          { id: 1 as never, personId, subject: '+1', content: 'Likes hiking', createdAtMs: 1 },
          {
            id: 2 as never,
            personId: asPersonId('person:other'),
            subject: 'Other',
            content: 'Nope',
            createdAtMs: 1,
          },
        ];
      },
    };

    const ctx = {
      now: new Date(),
      signal: new AbortController().signal,
      chat: {
        chatId,
        channel: 'signal',
        channelUserId: 'signal:+1',
        isGroup: false,
        isOperator: false,
      },
      services: { memoryStore: store as MemoryStore },
    };

    const res = await recallTool.execute({ query: 'hiking' }, ctx);
    expect(res).toMatchObject({
      status: 'ok',
      scope: { kind: 'dm', chatId: String(chatId) },
      results: { personFacts: [{ content: expect.stringContaining('Likes hiking') }] },
    });
    expect(JSON.stringify(res)).not.toContain('"Nope"');
  });
});
