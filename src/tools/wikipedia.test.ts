import { describe, expect, test } from 'bun:test';
import { withMockFetch } from '../testing/mockFetch.js';
import type { ToolContext } from './types.js';
import { wikipediaTool } from './wikipedia.js';

describe('wikipediaTool', () => {
  const ctx = (): ToolContext => ({
    now: new Date(),
    signal: new AbortController().signal,
  });

  test('search returns sources and external-wrapped text', async () => {
    await withMockFetch(
      (async (input: unknown) => {
        const url = String(input);
        if (!url.startsWith('https://en.wikipedia.org/w/api.php?')) {
          return new Response('bad', { status: 400 });
        }
        return new Response(
          JSON.stringify({
            query: {
              search: [{ title: 'Bun', snippet: 'Bun is a <b>runtime</b>.' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
      async () => {
        const out = (await wikipediaTool.execute(
          { action: 'search', query: 'Bun', limit: 1 },
          ctx(),
        )) as {
          ok: boolean;
          sources: Array<{ title: string; url: string }>;
          text: string;
        };
        expect(out.ok).toBe(true);
        expect(out.sources[0]?.url).toContain('wikipedia.org/wiki/');
        expect(out.text).toContain('<external title="wikipedia_search:Bun">');
      },
    );
  });

  test('summary fetch returns extract', async () => {
    await withMockFetch(
      (async (input: unknown) => {
        const url = String(input);
        if (!url.startsWith('https://en.wikipedia.org/api/rest_v1/page/summary/')) {
          return new Response('bad', { status: 400 });
        }
        return new Response(
          JSON.stringify({
            title: 'Bun',
            extract: 'Bun is a JavaScript runtime.',
            content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Bun' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
      async () => {
        const out = (await wikipediaTool.execute({ action: 'summary', title: 'Bun' }, ctx())) as {
          ok: boolean;
          text: string;
          sources: Array<{ title: string; url: string }>;
        };
        expect(out.ok).toBe(true);
        expect(out.sources[0]?.url).toBe('https://en.wikipedia.org/wiki/Bun');
        expect(out.text).toContain('Bun is a JavaScript runtime');
      },
    );
  });
});
