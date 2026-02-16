import { describe, expect, test } from 'bun:test';

import { readUrlTool } from './read-url.js';

describe('readUrlTool', () => {
  test('rejects non-http(s) URLs', async () => {
    await expect(readUrlTool.execute({ url: 'file:///etc/passwd' }, { now: new Date() })).rejects.toThrow(
      'Only http(s) URLs are allowed.',
    );
  });

  test('strips HTML and wraps as external', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response('<html>hi<script>bad()</script></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;

    try {
      const out = (await readUrlTool.execute(
        { url: 'https://example.com', maxBytes: 100_000 },
        { now: new Date() },
      )) as { text: string };
      expect(out.text).toContain('<external title="https://example.com">');
      expect(out.text).toContain('hi');
      expect(out.text).not.toContain('bad()');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

