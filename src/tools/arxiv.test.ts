import { describe, expect, test } from 'bun:test';
import { withMockFetch } from '../testing/mockFetch.js';
import { arxivTool } from './arxiv.js';
import type { ToolContext } from './types.js';

describe('arxivTool', () => {
  const ctx = (): ToolContext => ({
    now: new Date(),
    signal: new AbortController().signal,
  });

  test('parses Atom entries into external-wrapped text', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1234.5678v1</id>
    <updated>2026-02-22T00:00:00Z</updated>
    <published>2026-02-22T00:00:00Z</published>
    <title>Test &amp;quot;Paper&amp;quot;</title>
    <summary>Hello world</summary>
    <author><name>Alice</name></author>
  </entry>
</feed>`;

    await withMockFetch(
      (async () => {
        return new Response(xml, {
          status: 200,
          headers: { 'content-type': 'application/atom+xml' },
        });
      }) as unknown as typeof fetch,
      async () => {
        const out = (await arxivTool.execute({ query: 'test', limit: 1 }, ctx())) as {
          ok: boolean;
          sources: Array<{ title: string; url: string }>;
          text: string;
        };
        expect(out.ok).toBe(true);
        expect(out.sources[0]?.url).toContain('arxiv.org/abs/1234.5678');
        expect(out.text).toContain('<external title="arxiv:test">');
        expect(out.text).toContain('Test "Paper"');
      },
    );
  });
});
