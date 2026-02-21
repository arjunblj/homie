import { z } from 'zod';
import { sanitizeExternalContent } from '../security/contentSanitizer.js';
import { defineTool } from './define.js';
import type { ToolDef } from './types.js';
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

export const webSearchTool: ToolDef = defineTool({
  name: 'web_search',
  tier: 'safe',
  description:
    'Search the web (uses Brave Search if BRAVE_API_KEY is set; otherwise returns an error).',
  effects: ['network'],
  timeoutMs: 30_000,
  inputSchema: WebSearchInputSchema,
  execute: async ({ query, count }, ctx) => {
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
      signal: ctx.signal,
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
    if (!res.ok) {
      return { ok: false, error: `Brave HTTP ${res.status}`, results: [] };
    }

    const raw = truncateBytes(await res.text(), 200_000);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (_err) {
      return { ok: false, error: 'Brave response parse failed', results: [] };
    }
    const parsed = BraveResponseSchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, error: 'Brave response parse failed', results: [] };
    }

    type BraveResult = {
      title?: string | undefined;
      url: string;
      description?: string | undefined;
    };
    const webResults: BraveResult[] = parsed.data.web?.results ?? [];
    const sanitizeSnippet = (s: string): string => {
      // Keep snippets small and strip common instruction-like patterns.
      return sanitizeExternalContent(s, { maxLength: 800 }).sanitizedText;
    };
    const results = webResults.map((r: BraveResult) => ({
      title: sanitizeSnippet(r.title ?? r.url),
      url: r.url,
      snippet: sanitizeSnippet(r.description ?? ''),
    }));

    for (const r of results) {
      try {
        ctx.verifiedUrls?.add(new URL(r.url).toString());
      } catch (_err) {
        ctx.verifiedUrls?.add(r.url);
      }
    }

    return {
      ok: true,
      query,
      results,
      text: wrapExternal(
        `web_search:${query}`,
        results
          .map((r: (typeof results)[number], i: number) =>
            `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`.trim(),
          )
          .join('\n\n'),
      ),
    };
  },
});
