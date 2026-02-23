import { z } from 'zod';

import { sanitizeExternalContent } from '../security/contentSanitizer.js';
import { TtlCache } from './cache.js';
import { defineTool } from './define.js';
import type { ToolDef } from './types.js';
import { wrapExternal } from './util.js';

const BrowseWebInputSchema = z.object({
  task: z.string().min(1).max(2000),
  start_url: z.string().url().optional(),
  allowed_domains: z.array(z.string().min(1).max(200)).max(20).optional(),
  max_steps: z.number().int().min(1).max(25).optional().default(25),
});

type BrowseWebOutput = {
  ok: boolean;
  text: string;
  error?: string | undefined;
  costUsd?: number | undefined;
  taskId?: string | undefined;
};

const RESULT_CACHE = new TtlCache<BrowseWebOutput>({ maxKeys: 200 });

const ttlFor = (startUrl: string | undefined): number => {
  if (!startUrl) return 20 * 60_000;
  try {
    const host = new URL(startUrl).hostname.toLowerCase();
    if (host === 'news.ycombinator.com') return 10 * 60_000;
    if (host === 'x.com' || host === 'twitter.com') return 5 * 60_000;
    return 20 * 60_000;
  } catch (_err) {
    return 20 * 60_000;
  }
};

export const browseWebTool: ToolDef = defineTool({
  name: 'browse_web',
  tier: 'restricted',
  description: 'Use a remote browser to complete a web task (operator-only).',
  guidance:
    'Use for interactive pages that web_search/read_url cannot handle. Prefer minimal steps and return sources.',
  effects: ['network'],
  timeoutMs: 90_000,
  inputSchema: BrowseWebInputSchema,
  execute: async (input, ctx): Promise<BrowseWebOutput> => {
    interface ToolEnv extends NodeJS.ProcessEnv {
      BROWSER_USE_API_KEY?: string;
    }
    const env = process.env as ToolEnv;
    const apiKey = env.BROWSER_USE_API_KEY?.trim() ?? '';
    if (!apiKey) {
      return {
        ok: false,
        error: 'not_configured: set BROWSER_USE_API_KEY',
        text: '',
      };
    }

    const cacheKey = [
      'browse_web',
      input.start_url ?? '',
      (input.allowed_domains ?? []).join(','),
      String(input.max_steps),
      input.task,
    ].join('|');
    const cached = RESULT_CACHE.get(cacheKey);
    if (cached) return cached;

    const { BrowserUseClient } = await import('browser-use-sdk');
    const client = new BrowserUseClient({ apiKey });

    const resultSchema = z
      .object({
        answer: z.string().min(1),
        sources: z
          .array(z.object({ url: z.string().url(), title: z.string().optional() }))
          .max(10)
          .default([]),
      })
      .strict();

    const createRes = await client.tasks.createTask({
      task: input.task,
      ...(input.start_url ? { startUrl: input.start_url } : {}),
      ...(input.allowed_domains?.length ? { allowedDomains: input.allowed_domains } : {}),
      maxSteps: input.max_steps,
      flashMode: true,
      schema: resultSchema,
    });

    const completed = await createRes.complete({ interval: 2000 }, { signal: ctx.signal });
    const parsed = (completed as unknown as { parsed?: unknown }).parsed;
    const parsedResult = parsed ? resultSchema.safeParse(parsed) : { success: false as const };

    let rawText = '';
    if (parsedResult.success) {
      const sources = parsedResult.data.sources
        .map((s, i) => `${i + 1}. ${s.title ?? s.url}\n${s.url}`.trim())
        .join('\n\n');
      rawText = `${parsedResult.data.answer}\n\n=== SOURCES ===\n${sources}`.trim();
      for (const s of parsedResult.data.sources) {
        try {
          ctx.verifiedUrls?.add(new URL(s.url).toString());
        } catch (_err) {
          ctx.verifiedUrls?.add(s.url);
        }
      }
    } else {
      const r = (completed as unknown as { result?: unknown }).result;
      rawText = typeof r === 'string' ? r : JSON.stringify(r ?? completed);
    }

    const sanitized = sanitizeExternalContent(rawText, { maxLength: 25_000 }).sanitizedText.trim();
    const wrapped = wrapExternal(`browse_web:${input.start_url ?? 'task'}`, sanitized || rawText);
    const costStr = (completed as unknown as { cost?: string | undefined }).cost;
    const costUsd = costStr ? Number(costStr) : undefined;

    const out: BrowseWebOutput = {
      ok: true,
      text: wrapped,
      ...(typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}),
      ...(createRes?.id ? { taskId: String(createRes.id) } : {}),
    };
    RESULT_CACHE.set(cacheKey, out, ttlFor(input.start_url));
    return out;
  },
});
