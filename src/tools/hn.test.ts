import { describe, expect, test } from 'bun:test';
import { withMockFetch } from '../testing/mockFetch.js';
import { hnTool } from './hn.js';
import type { ToolContext } from './types.js';

describe('hnTool', () => {
  const ctx = (): ToolContext => ({
    now: new Date(),
    signal: new AbortController().signal,
  });

  test('feed returns external-wrapped sources', async () => {
    await withMockFetch(
      (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/topstories.json')) {
          return new Response(JSON.stringify([111, 222]), { status: 200 });
        }
        if (url.endsWith('/item/111.json')) {
          return new Response(
            JSON.stringify({ id: 111, title: 'Hello', url: 'https://a.example/' }),
            {
              status: 200,
            },
          );
        }
        if (url.endsWith('/item/222.json')) {
          return new Response(
            JSON.stringify({ id: 222, title: 'World', url: 'https://b.example/' }),
            {
              status: 200,
            },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch,
      async () => {
        const out = (await hnTool.execute({ action: 'feed', feed: 'top', limit: 2 }, ctx())) as {
          ok: boolean;
          text: string;
          sources: Array<{ title: string; url: string }>;
        };
        expect(out.ok).toBe(true);
        expect(out.sources.length).toBe(2);
        expect(out.text).toContain('<external title="hn:top">');
        expect(out.text).toContain('https://a.example/');
      },
    );
  });

  test('search uses Algolia endpoint', async () => {
    await withMockFetch(
      (async (input: unknown) => {
        const url = String(input);
        if (url.startsWith('https://hn.algolia.com/api/v1/search?')) {
          return new Response(
            JSON.stringify({
              hits: [{ title: 'A', url: 'https://a.example/', objectID: '123' }],
            }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch,
      async () => {
        const out = (await hnTool.execute(
          { action: 'search', query: 'test', limit: 1 },
          ctx(),
        )) as {
          ok: boolean;
          text: string;
          sources: Array<{ title: string; url: string }>;
        };
        expect(out.ok).toBe(true);
        expect(out.sources[0]?.url).toBe('https://a.example/');
        expect(out.text).toContain('<external title="hn_search:test">');
      },
    );
  });
});
