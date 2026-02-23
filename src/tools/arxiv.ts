import { z } from 'zod';

import { sanitizeExternalContent } from '../security/contentSanitizer.js';
import { TtlCache } from './cache.js';
import { defineTool } from './define.js';
import type { ToolDef } from './types.js';
import { wrapExternal } from './util.js';

type ArxivSource = { title: string; url: string };

const ARXIV_API = 'https://export.arxiv.org/api/query';

const clean = (s: string, maxLength: number): string => {
  return sanitizeExternalContent(String(s ?? ''), { maxLength })
    .sanitizedText.replace(/\s+/gu, ' ')
    .trim();
};

const unescapeXml = (s: string): string => {
  return String(s ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
};

const extractTagText = (block: string, tag: string): string => {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'iu');
  const m = re.exec(block);
  if (!m?.[1]) return '';
  return unescapeXml(m[1]).replace(/\s+/gu, ' ').trim();
};

const extractAllTagText = (block: string, tag: string): string[] => {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'giu');
  const out: string[] = [];
  for (const match of block.matchAll(re)) {
    const raw = match[1] ?? '';
    const t = unescapeXml(raw).replace(/\s+/gu, ' ').trim();
    if (t) out.push(t);
  }
  return out;
};

const extractEntryBlocks = (xml: string): string[] => {
  const out: string[] = [];
  const re = /<entry\b[^>]*>[\s\S]*?<\/entry>/giu;
  for (const m of xml.matchAll(re)) {
    if (m[0]) out.push(m[0]);
  }
  return out;
};

const ArxivInputSchema = z.object({
  query: z.string().min(1).max(300),
  limit: z.number().int().min(1).max(10).optional().default(5),
});

const CACHE = new TtlCache<unknown>({ maxKeys: 400 });

export const arxivTool: ToolDef = defineTool({
  name: 'arxiv',
  tier: 'safe',
  description: 'Search arXiv papers (keyless) and return recent results.',
  guidance: 'Use for paper discovery; follow up with read_url for deep reading.',
  effects: ['network'],
  timeoutMs: 25_000,
  inputSchema: ArxivInputSchema,
  execute: async ({ query, limit }, ctx) => {
    const cacheKey = `arxiv:${query}|${String(limit)}`;
    const cached = CACHE.get(cacheKey);
    if (cached) return cached;

    try {
      const u = new URL(ARXIV_API);
      // arXiv supports a mini query language; simplest is all:...
      u.searchParams.set('search_query', `all:${query}`);
      u.searchParams.set('start', '0');
      u.searchParams.set('max_results', String(limit));
      u.searchParams.set('sortBy', 'submittedDate');
      u.searchParams.set('sortOrder', 'descending');

      const res = await fetch(u, {
        signal: ctx.signal,
        headers: { Accept: 'application/atom+xml' },
      });
      if (!res.ok) {
        const out = {
          ok: false,
          error: `HTTP ${res.status}`,
          sources: [] as ArxivSource[],
          text: '',
        };
        CACHE.set(cacheKey, out, 10_000);
        return out;
      }
      const xml = (await res.text()).slice(0, 600_000);
      const entries = extractEntryBlocks(xml).slice(0, limit);
      const sources: ArxivSource[] = entries.map((e) => {
        const title = clean(extractTagText(e, 'title'), 160) || 'arXiv paper';
        const id = extractTagText(e, 'id');
        const url = id.trim() || ARXIV_API;
        return { title, url };
      });

      const lines = entries.map((e, i) => {
        const title = clean(extractTagText(e, 'title'), 160) || `Result ${String(i + 1)}`;
        const url = extractTagText(e, 'id').trim();
        const authors = extractAllTagText(e, 'name')
          .slice(0, 6)
          .map((a) => clean(a, 60))
          .filter(Boolean)
          .join(', ');
        const published = clean(extractTagText(e, 'published'), 40);
        const summary = clean(extractTagText(e, 'summary'), 700);
        return [
          `${i + 1}. ${title}`,
          url ? `URL: ${url}` : '',
          authors ? `Authors: ${authors}` : '',
          published ? `Published: ${published}` : '',
          summary ? `Summary: ${summary}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      });

      const text = wrapExternal(`arxiv:${query}`, lines.join('\n\n'));
      const out = { ok: true, query, sources, text };
      CACHE.set(cacheKey, out, 20 * 60_000);
      return out;
    } catch (err) {
      const out = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        sources: [] as ArxivSource[],
        text: '',
      };
      CACHE.set(cacheKey, out, 10_000);
      return out;
    }
  },
});
