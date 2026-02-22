import { z } from 'zod';
import { sanitizeExternalContent } from '../security/contentSanitizer.js';
import { defineTool } from './define.js';
import { readUrlTool } from './read-url.js';
import type { ToolContext, ToolDef } from './types.js';
import { webSearchTool } from './web-search.js';

const DeepResearchInputSchema = z.object({
  query: z.string().min(1),
  /**
   * Higher depth increases how many sources we consider, but output remains bounded.
   * This is a latency control, not "infinite research".
   */
  depth: z.number().int().min(1).max(3).optional().default(2),
  /**
   * Advisory freshness hint used only for cache TTL selection. Search results are
   * still bounded and deterministic.
   */
  freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  /**
   * Optional URL allowlist. If provided, the tool can run without web search.
   * Note: `read_url` also enforces ctx.verifiedUrls if present.
   */
  urls: z.array(z.string().url()).max(10).optional(),
});

type DeepResearchInput = z.infer<typeof DeepResearchInputSchema>;

type DeepResearchStatus = 'ok' | 'search_not_configured' | 'no_sources' | 'error';

type EvidenceItem = {
  url: string;
  title?: string | undefined;
  snippets: string[];
};

type SourceItem = {
  url: string;
  title?: string | undefined;
  publishedAt?: string | undefined;
  retrievedAtMs: number;
};

type DeepResearchResult = {
  evidence: EvidenceItem[];
  sources: SourceItem[];
  limits: {
    searchesUsed: number;
    urlsRead: number;
    bytesReadApprox: number;
    sourcesConsidered: number;
  };
  status: DeepResearchStatus;
  error?: { code: string; message: string } | undefined;
};

type CachedRead = {
  expiresAtMs: number;
  value:
    | {
        ok: true;
        url: string;
        finalUrl: string;
        contentType: string;
        truncated: boolean;
        text: string;
      }
    | { ok: false; url: string; error: string };
  bytesApprox: number;
};

const READ_CACHE = new Map<string, CachedRead>();
const READ_CACHE_MAX_ENTRIES = 200;

const bytesApprox = (s: string): number => {
  try {
    return new TextEncoder().encode(s).byteLength;
  } catch (_err) {
    return s.length;
  }
};

const clampInt = (n: number, lo: number, hi: number): number => {
  const x = Math.floor(n);
  return Math.max(lo, Math.min(hi, x));
};

const uniqStable = <T>(items: readonly T[], key: (t: T) => string): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
};

const unescapeXmlText = (s: string): string => {
  // Reverse of wrapExternal's escaping for text nodes.
  // Note: wrapExternal escapes only &, <, > for text content (not quotes).
  return s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
};

const unwrapExternal = (maybeWrapped: string): string => {
  const open = maybeWrapped.indexOf('\n');
  if (!maybeWrapped.startsWith('<external ') || open < 0) return maybeWrapped;
  const close = maybeWrapped.lastIndexOf('\n</external>');
  if (close < 0 || close <= open) return maybeWrapped;
  const inner = maybeWrapped.slice(open + 1, close);
  return unescapeXmlText(inner);
};

const tokenizeQuery = (query: string): string[] => {
  const parts = query.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? [];
  return uniqStable(parts, (x) => x).slice(0, 12);
};

const pickSnippets = (content: string, query: string, maxSnippets: number): string[] => {
  const clean = sanitizeExternalContent(content, { maxLength: 25_000 }).sanitizedText;
  if (!clean) return [];

  const tokens = tokenizeQuery(query);
  const lower = clean.toLowerCase();
  const windowChars = 420;
  const half = Math.floor(windowChars / 2);

  const windows: Array<{ start: number; score: number }> = [];
  for (const t of tokens) {
    let idx = lower.indexOf(t);
    let seen = 0;
    while (idx >= 0 && seen < 4) {
      const start = Math.max(0, idx - half);
      const slice = lower.slice(start, Math.min(lower.length, start + windowChars));
      const score = tokens.reduce((acc, tok) => acc + (slice.includes(tok) ? 1 : 0), 0);
      windows.push({ start, score });
      seen += 1;
      idx = lower.indexOf(t, idx + t.length);
    }
  }

  windows.sort((a, b) => b.score - a.score || a.start - b.start);
  const starts = uniqStable(windows, (w) => String(w.start)).map((w) => w.start);

  const out: string[] = [];
  const add = (snippet: string): void => {
    const s = sanitizeExternalContent(snippet, { maxLength: 420 }).sanitizedText.trim();
    if (!s) return;
    if (out.includes(s)) return;
    out.push(s);
  };

  // Always include the beginning as a grounding snippet.
  add(clean.slice(0, windowChars));
  for (const start of starts) {
    if (out.length >= maxSnippets) break;
    add(clean.slice(start, Math.min(clean.length, start + windowChars)));
  }

  return out.slice(0, maxSnippets);
};

const readCacheTtlMs = (freshness: DeepResearchInput['freshness']): number => {
  // Best-effort TTL cache: reduce repeat fetches during a single runtime session.
  switch (freshness) {
    case 'day':
      return 5 * 60_000;
    case 'week':
      return 30 * 60_000;
    case 'month':
      return 2 * 60 * 60_000;
    case 'year':
      return 6 * 60 * 60_000;
    default:
      return 30 * 60_000;
  }
};

const evictExpiredReads = (nowMs: number): void => {
  for (const [k, v] of READ_CACHE) {
    if (v.expiresAtMs <= nowMs) READ_CACHE.delete(k);
  }
};

const getCachedRead = (url: string, nowMs: number): CachedRead | undefined => {
  const c = READ_CACHE.get(url);
  if (!c) return undefined;
  if (c.expiresAtMs <= nowMs) {
    READ_CACHE.delete(url);
    return undefined;
  }
  return c;
};

const setCachedRead = (
  url: string,
  nowMs: number,
  ttlMs: number,
  value: CachedRead['value'],
): void => {
  evictExpiredReads(nowMs);
  const approx = value.ok
    ? bytesApprox(value.text)
    : bytesApprox(value.error) + bytesApprox(value.url);
  // Refresh insertion order (Map iteration order) for simple LRU behavior.
  READ_CACHE.delete(url);
  READ_CACHE.set(url, {
    expiresAtMs: nowMs + Math.max(1, Math.floor(ttlMs)),
    value,
    bytesApprox: approx,
  });
  while (READ_CACHE.size > READ_CACHE_MAX_ENTRIES) {
    const oldest = READ_CACHE.keys().next();
    if (oldest.done) break;
    READ_CACHE.delete(oldest.value);
  }
};

const hasBraveApiKey = (): boolean => {
  interface ToolEnv extends NodeJS.ProcessEnv {
    BRAVE_API_KEY?: string;
  }
  const env = process.env as ToolEnv;
  return Boolean(env.BRAVE_API_KEY?.trim());
};

export const deepResearchTool: ToolDef = defineTool({
  name: 'deep_research',
  tier: 'safe',
  description:
    'Gather a bounded evidence bundle for deep research (web_search + read_url), with citations and strict caps.',
  guidance: [
    'Use this tool to gather evidence, then synthesize your final answer yourself.',
    'Cite URLs from `sources` for factual claims.',
    'When stating facts, quote directly from `evidence[].snippets` when possible.',
    'If evidence is thin or conflicting, say so explicitly.',
  ].join(' '),
  effects: ['network'],
  timeoutMs: 75_000,
  inputSchema: DeepResearchInputSchema,
  execute: async (input: DeepResearchInput, ctx: ToolContext): Promise<DeepResearchResult> => {
    const nowMs = ctx.now.getTime();
    const depth = clampInt(input.depth, 1, 3);
    const maxUrlsRead = clampInt(2 + depth, 3, 6);
    const maxSearchResults = clampInt(2 + depth * 2, 3, 8);
    const maxBytesPerUrl = 90_000;
    const maxSnippetsPerSource = 4;
    const ttlMs = readCacheTtlMs(input.freshness);

    const limits: DeepResearchResult['limits'] = {
      searchesUsed: 0,
      urlsRead: 0,
      bytesReadApprox: 0,
      sourcesConsidered: 0,
    };

    const toolCtx = ctx.verifiedUrls ? ctx : { ...ctx, verifiedUrls: new Set<string>() };
    const verifiedUrls = toolCtx.verifiedUrls ?? new Set<string>();

    const urlHints = (input.urls ?? []).map((u) => u.trim()).filter(Boolean);
    const normalizedHints = uniqStable(urlHints, (u) => u).slice(0, 10);
    for (const u of normalizedHints) {
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return {
            evidence: [],
            sources: [],
            limits,
            status: 'error',
            error: { code: 'invalid_url', message: 'Only http(s) URLs are allowed.' },
          };
        }
        verifiedUrls.add(parsed.toString());
      } catch (_err) {
        return {
          evidence: [],
          sources: [],
          limits,
          status: 'error',
          error: { code: 'invalid_url', message: 'Invalid URL in urls.' },
        };
      }
    }

    let searchResults: Array<{ url: string; title?: string | undefined }> = [];
    if (normalizedHints.length === 0) {
      if (!hasBraveApiKey()) {
        return {
          evidence: [],
          sources: [],
          limits,
          status: 'search_not_configured',
          error: {
            code: 'search_not_configured',
            message: 'No urls provided and BRAVE_API_KEY is not set.',
          },
        };
      }
      let search:
        | { ok: true; results: Array<{ url: string; title?: string | undefined }> }
        | { ok: false; error?: string | undefined; results: unknown[] };
      try {
        search = (await webSearchTool.execute(
          { query: input.query, count: maxSearchResults },
          toolCtx,
        )) as typeof search;
      } catch (_err) {
        return {
          evidence: [],
          sources: [],
          limits,
          status: 'error',
          error: { code: 'search_failed', message: 'Web search failed.' },
        };
      }
      limits.searchesUsed += 1;
      if (!('ok' in search) || search.ok !== true) {
        return {
          evidence: [],
          sources: [],
          limits,
          status: 'error',
          error: {
            code: 'search_failed',
            message:
              typeof search.error === 'string' && search.error.trim()
                ? search.error.trim()
                : 'Web search failed.',
          },
        };
      }
      searchResults = (search.results ?? []).map((r) => ({ url: r.url, title: r.title }));
    }

    const candidates = uniqStable(
      [
        ...normalizedHints.map((u) => ({ url: u, title: undefined as string | undefined })),
        ...searchResults,
      ],
      (x) => x.url,
    ).slice(0, 12);
    limits.sourcesConsidered = candidates.length;

    if (candidates.length === 0) {
      return { evidence: [], sources: [], limits, status: 'no_sources' };
    }

    const evidence: EvidenceItem[] = [];
    const sources: SourceItem[] = [];

    for (const c of candidates) {
      if (limits.urlsRead >= maxUrlsRead) break;
      const url = c.url;
      limits.urlsRead += 1;

      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          verifiedUrls.add(parsed.toString());
        } else {
          continue;
        }
      } catch (_err) {
        continue;
      }

      const cached = getCachedRead(url, nowMs);
      let read: CachedRead['value'];
      if (cached?.value) {
        read = cached.value;
      } else {
        try {
          read = (await readUrlTool.execute(
            { url, maxBytes: maxBytesPerUrl },
            toolCtx,
          )) as CachedRead['value'];
        } catch (_err) {
          read = { ok: false, url, error: 'read_url_failed' };
        }
      }
      if (!cached) setCachedRead(url, nowMs, ttlMs, read);
      limits.bytesReadApprox +=
        cached?.bytesApprox ?? (read.ok ? bytesApprox(read.text) : bytesApprox(read.error));

      if (!read.ok) continue;

      const content = unwrapExternal(read.text);
      const snippets = pickSnippets(content, input.query, maxSnippetsPerSource);
      if (snippets.length === 0) continue;

      evidence.push({
        url: read.finalUrl || url,
        ...(c.title ? { title: c.title } : {}),
        snippets,
      });
      sources.push({
        url: read.finalUrl || url,
        ...(c.title ? { title: c.title } : {}),
        retrievedAtMs: nowMs,
      });
    }

    if (evidence.length === 0) {
      return { evidence: [], sources: [], limits, status: 'no_sources' };
    }

    return { evidence, sources, limits, status: 'ok' };
  },
});
