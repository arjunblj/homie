import { z } from 'zod';
import { defineTool } from './define.js';

import { truncateBytes, wrapExternal } from './util.js';

const BraveResponseSchema = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().optional(),
            url: z.string().url(),
            description: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});

const WebSearchInputSchema = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).max(10).optional().default(5),
});

export const webSearchTool = defineTool({
  name: 'web_search',
  tier: 'safe',
  description:
    'Search the web (uses Brave Search if BRAVE_API_KEY is set; otherwise returns an error).',
  inputSchema: WebSearchInputSchema,
  execute: async ({ query, count }) => {
    interface ToolEnv extends NodeJS.ProcessEnv {
      BRAVE_API_KEY?: string;
    }
    const env = process.env as ToolEnv;
    const apiKey = env.BRAVE_API_KEY?.trim();
    if (!apiKey) {
      return {
        ok: false,
        error:
          'Web search is not configured. Set BRAVE_API_KEY to enable Brave Search (recommended).',
        results: [],
      };
    }

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
    if (!res.ok) {
      return { ok: false, error: `Brave HTTP ${res.status}`, results: [] };
    }

    const raw = truncateBytes(await res.text(), 200_000);
    const parsed = BraveResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { ok: false, error: 'Brave response parse failed', results: [] };
    }

    const results = (parsed.data.web?.results ?? []).map((r) => ({
      title: r.title ?? r.url,
      url: r.url,
      snippet: r.description ?? '',
    }));

    return {
      ok: true,
      query,
      results,
      text: wrapExternal(
        `web_search:${query}`,
        results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`.trim()).join('\n\n'),
      ),
    };
  },
});
