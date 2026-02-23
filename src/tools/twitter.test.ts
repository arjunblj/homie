import { describe, expect, test } from 'bun:test';

import { withMockEnv } from '../testing/mockEnv.js';
import { withMockFetch } from '../testing/mockFetch.js';
import { readTimelineTool, readTweetTool, searchTweetsTool } from './twitter.js';
import type { ToolContext } from './types.js';

const ctx = (): ToolContext => ({
  now: new Date(),
  signal: new AbortController().signal,
  verifiedUrls: new Set<string>(),
});

describe('twitter tools', () => {
  test('read_tweet returns not_configured without X_BEARER_TOKEN', async () => {
    await withMockEnv({ X_BEARER_TOKEN: undefined }, async () => {
      const out = (await readTweetTool.execute({ id_or_url: '1234567890' }, ctx())) as {
        ok: boolean;
        error?: string;
      };
      expect(out.ok).toBe(false);
      expect(out.error).toContain('X_BEARER_TOKEN');
    });
  });

  test('read_tweet accepts x.com status URL and can expand thread', async () => {
    await withMockEnv({ X_BEARER_TOKEN: 't' }, async () => {
      await withMockFetch(
        (async (input: RequestInfo | URL) => {
          const u =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (u.startsWith('https://api.x.com/2/tweets/1234567890')) {
            return new Response(
              JSON.stringify({
                data: {
                  id: '1234567890',
                  text: 'Hello world',
                  author_id: '42',
                  created_at: '2026-01-01T00:00:00.000Z',
                  conversation_id: '1234567890',
                },
                includes: { users: [{ id: '42', username: 'alice', name: 'Alice' }] },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          if (u.startsWith('https://api.x.com/2/tweets/search/recent')) {
            return new Response(
              JSON.stringify({
                data: [
                  { id: '1234567890', text: 'Hello world', created_at: '2026-01-01T00:00:00.000Z' },
                  { id: '1234567891', text: 'Follow-up', created_at: '2026-01-01T00:01:00.000Z' },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response('no', { status: 404 });
        }) as unknown as typeof fetch,
        async () => {
          const out = (await readTweetTool.execute(
            {
              id_or_url: 'https://x.com/alice/status/1234567890',
              include_thread: true,
              thread_mode: 'author',
              max_thread_tweets: 10,
            },
            ctx(),
          )) as { ok: boolean; id?: string; text?: string };
          expect(out.ok).toBe(true);
          expect(out.id).toBe('1234567890');
          expect(out.text ?? '').toContain('<external');
          expect(out.text ?? '').toContain('THREAD');
          expect(out.text ?? '').toContain('Follow-up');
        },
      );
    });
  });

  test('search_tweets returns cursor when next_token present', async () => {
    await withMockEnv({ X_BEARER_TOKEN: 't' }, async () => {
      await withMockFetch(
        (async () => {
          return new Response(
            JSON.stringify({
              data: [{ id: '1', text: 'A', created_at: '2026-01-01T00:00:00.000Z' }],
              meta: { next_token: 'n' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as unknown as typeof fetch,
        async () => {
          const out = (await searchTweetsTool.execute({ query: 'bun', count: 1 }, ctx())) as {
            ok: boolean;
            cursor?: string;
            text?: string;
          };
          expect(out.ok).toBe(true);
          expect(out.cursor).toBe('n');
          expect(out.text ?? '').toContain('<external');
        },
      );
    });
  });

  test('read_timeline resolves username and returns tweets', async () => {
    await withMockEnv({ X_BEARER_TOKEN: 't' }, async () => {
      await withMockFetch(
        (async (input: RequestInfo | URL) => {
          const u =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (u.startsWith('https://api.x.com/2/users/by/username/alice')) {
            return new Response(JSON.stringify({ data: { id: '42', username: 'alice' } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (u.startsWith('https://api.x.com/2/users/42/tweets')) {
            return new Response(
              JSON.stringify({
                data: [
                  { id: '1', text: 'hi', created_at: '2026-01-01T00:00:00.000Z' },
                  { id: '2', text: 'yo', created_at: '2026-01-01T00:01:00.000Z' },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response('no', { status: 404 });
        }) as unknown as typeof fetch,
        async () => {
          const out = (await readTimelineTool.execute({ username: 'alice', count: 2 }, ctx())) as {
            ok: boolean;
            text?: string;
          };
          expect(out.ok).toBe(true);
          expect(out.text ?? '').toContain('read_timeline:alice');
          expect(out.text ?? '').toContain('hi');
        },
      );
    });
  });
});
