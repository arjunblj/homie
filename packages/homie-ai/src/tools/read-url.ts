import { z } from 'zod';
import { defineTool } from './define.js';

import { truncateBytes, wrapExternal } from './util.js';

const stripHtml = (html: string): string => {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, '')
    .replace(/<style[\s\S]*?<\/style>/giu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

const ReadUrlInputSchema = z.object({
  url: z.string().url(),
  maxBytes: z.number().int().min(1024).max(250_000).optional().default(120_000),
});

export const readUrlTool = defineTool({
  name: 'read_url',
  tier: 'safe',
  description: 'Fetch a URL and return the textual content (isolated as external input).',
  inputSchema: ReadUrlInputSchema,
  execute: async ({ url, maxBytes }) => {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('Only http(s) URLs are allowed.');
    }

    const res = await fetch(u);
    const contentType = res.headers.get('content-type') ?? 'unknown';
    const raw = await res.text();
    const clipped = truncateBytes(raw, maxBytes);

    const text = contentType.includes('text/html') ? stripHtml(clipped) : clipped;
    return {
      url,
      contentType,
      text: wrapExternal(url, text),
    };
  },
});
