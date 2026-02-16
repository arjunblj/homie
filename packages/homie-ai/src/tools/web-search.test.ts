import { describe, expect, test } from 'bun:test';

import { webSearchTool } from './web-search.js';

describe('webSearchTool', () => {
  test('returns error when BRAVE_API_KEY not set', async () => {
    const prev = process.env['BRAVE_API_KEY'];
    delete process.env['BRAVE_API_KEY'];
    try {
      const out = (await webSearchTool.execute({ query: 'x', count: 2 }, { now: new Date() })) as {
        ok: boolean;
        error?: string;
      };
      expect(out.ok).toBe(false);
      expect(out.error).toContain('BRAVE_API_KEY');
    } finally {
      if (prev !== undefined) process.env['BRAVE_API_KEY'] = prev;
    }
  });

  test('parses Brave response and wraps as external', async () => {
    const prev = process.env['BRAVE_API_KEY'];
    process.env['BRAVE_API_KEY'] = 'k';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          web: {
            results: [
              { title: 't', url: 'https://example.com', description: 'd' },
              { url: 'https://example.org', description: 'd2' },
            ],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const out = (await webSearchTool.execute(
        { query: 'hello', count: 2 },
        { now: new Date() },
      )) as {
        ok: boolean;
        text?: string;
        results: unknown[];
      };
      expect(out.ok).toBe(true);
      expect(out.results.length).toBe(2);
      expect(out.text).toContain('<external title="web_search:hello">');
    } finally {
      globalThis.fetch = originalFetch;
      if (prev !== undefined) process.env['BRAVE_API_KEY'] = prev;
      else delete process.env['BRAVE_API_KEY'];
    }
  });

  test('returns error on Brave non-OK response', async () => {
    const prev = process.env['BRAVE_API_KEY'];
    process.env['BRAVE_API_KEY'] = 'k';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    try {
      const out = (await webSearchTool.execute({ query: 'x', count: 1 }, { now: new Date() })) as {
        ok: boolean;
        error?: string;
      };
      expect(out.ok).toBe(false);
      expect(out.error).toContain('Brave HTTP 500');
    } finally {
      globalThis.fetch = originalFetch;
      if (prev !== undefined) process.env['BRAVE_API_KEY'] = prev;
      else delete process.env['BRAVE_API_KEY'];
    }
  });
});
