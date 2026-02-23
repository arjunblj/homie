import { z } from 'zod';

import { sanitizeExternalContent } from '../security/contentSanitizer.js';
import { TtlCache } from './cache.js';
import { defineTool } from './define.js';
import type { ToolDef } from './types.js';
import { truncateBytes, wrapExternal } from './util.js';

type RateLimitInfo = {
  limit?: number | undefined;
  remaining?: number | undefined;
  resetAtMs?: number | undefined;
};

const parseRateLimit = (res: Response): RateLimitInfo => {
  // Avoid treating missing headers as 0 (Number('') === 0).
  const rawLimit = res.headers.get('x-rate-limit-limit');
  const rawRemaining = res.headers.get('x-rate-limit-remaining');
  const rawResetS = res.headers.get('x-rate-limit-reset');
  const limit = rawLimit ? Number(rawLimit) : NaN;
  const remaining = rawRemaining ? Number(rawRemaining) : NaN;
  const resetS = rawResetS ? Number(rawResetS) : NaN;
  return {
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(Number.isFinite(remaining) ? { remaining } : {}),
    ...(Number.isFinite(resetS) ? { resetAtMs: Math.floor(resetS * 1000) } : {}),
  };
};

const parseTweetId = (idOrUrl: string): string | null => {
  const s = idOrUrl.trim();
  if (/^\d{5,25}$/u.test(s)) return s;
  const m = /\/status\/(\d{5,25})\b/u.exec(s);
  if (m?.[1]) return m[1];
  const m2 = /\bstatus_id=(\d{5,25})\b/u.exec(s);
  if (m2?.[1]) return m2[1];
  return null;
};

const normalizeText = (s: string, maxLen: number): string => {
  const t = sanitizeExternalContent(s, { maxLength: maxLen }).sanitizedText;
  return t.trim();
};

const X_API_ROOT = 'https://api.x.com/2';
const X_TWEET_FIELDS = [
  'id',
  'text',
  'author_id',
  'created_at',
  'conversation_id',
  'referenced_tweets',
  'in_reply_to_user_id',
  'entities',
  'public_metrics',
  'lang',
  'source',
  'attachments',
  'possibly_sensitive',
  'reply_settings',
].join(',');
const X_USER_FIELDS = [
  'id',
  'name',
  'username',
  'profile_image_url',
  'verified',
  'verified_type',
  'public_metrics',
  'created_at',
].join(',');
const X_MEDIA_FIELDS = [
  'media_key',
  'type',
  'url',
  'preview_image_url',
  'variants',
  'width',
  'height',
  'alt_text',
  'duration_ms',
  'public_metrics',
].join(',');
const X_EXPANSIONS = [
  'author_id',
  'referenced_tweets.id',
  'referenced_tweets.id.author_id',
  'attachments.media_keys',
  'referenced_tweets.id.attachments.media_keys',
  'in_reply_to_user_id',
].join(',');

const RESPONSE_CACHE = new TtlCache<{
  status: number;
  json?: unknown;
  text?: string | undefined;
  rateLimit: RateLimitInfo;
}>({ maxKeys: 500 });

const USER_CACHE = new TtlCache<{ id: string; username: string; name?: string | undefined }>({
  maxKeys: 500,
});

const fetchXJson = async (opts: {
  path: string;
  query?: Record<string, string | undefined> | undefined;
  bearerToken: string;
  signal: AbortSignal;
  cacheKey?: string | undefined;
  cacheTtlMs?: number | undefined;
}): Promise<
  | { ok: true; status: number; json: unknown; rateLimit: RateLimitInfo }
  | { ok: false; status: number; error: string; rateLimit: RateLimitInfo; retryAfterMs?: number }
> => {
  const key = opts.cacheKey;
  if (key && opts.cacheTtlMs) {
    const cached = RESPONSE_CACHE.get(key);
    if (cached?.json) {
      return { ok: true, status: cached.status, json: cached.json, rateLimit: cached.rateLimit };
    }
  }

  const url = new URL(`${X_API_ROOT}${opts.path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    url.searchParams.set(k, v);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      signal: opts.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${opts.bearerToken}`,
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `x_network_error: ${err instanceof Error ? err.message : String(err)}`,
      rateLimit: {},
    };
  }

  const rateLimit = parseRateLimit(res);
  const body = truncateBytes(await res.text().catch(() => ''), 300_000);
  if (!res.ok) {
    const retryAfterMs =
      res.status === 429 && rateLimit.resetAtMs ? Math.max(0, rateLimit.resetAtMs - Date.now()) : 0;
    return {
      ok: false,
      status: res.status,
      error: `x_http_${res.status}: ${body.slice(0, 250)}`.trim(),
      rateLimit,
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (_err) {
    return { ok: false, status: res.status, error: 'x_parse_failed', rateLimit };
  }

  if (key && opts.cacheTtlMs) {
    RESPONSE_CACHE.set(key, { status: res.status, json, rateLimit }, opts.cacheTtlMs);
  }
  return { ok: true, status: res.status, json, rateLimit };
};

const resolveUserIdByUsername = async (opts: {
  username: string;
  bearerToken: string;
  signal: AbortSignal;
}): Promise<
  | { ok: true; user: { id: string; username: string; name?: string | undefined } }
  | { ok: false; error: string }
> => {
  const key = `user_by_username:${opts.username.toLowerCase()}`;
  const cached = USER_CACHE.get(key);
  if (cached) return { ok: true, user: cached };

  const r = await fetchXJson({
    path: `/users/by/username/${encodeURIComponent(opts.username)}`,
    bearerToken: opts.bearerToken,
    signal: opts.signal,
    query: { 'user.fields': X_USER_FIELDS },
    cacheKey: key,
    cacheTtlMs: 6 * 60 * 60_000,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const data = r.json as { data?: { id?: string; username?: string; name?: string } } | undefined;
  const id = data?.data?.id;
  const username = data?.data?.username;
  if (!id || !username) return { ok: false, error: 'x_user_lookup_failed' };
  const user = { id: String(id), username: String(username), name: data?.data?.name };
  USER_CACHE.set(key, user, 6 * 60 * 60_000);
  return { ok: true, user };
};

const formatTweet = (t: {
  id?: string;
  text?: string;
  created_at?: string;
  author_id?: string;
}): string => {
  const text = normalizeText(String(t.text ?? ''), 4000);
  const created = t.created_at ? ` (${String(t.created_at)})` : '';
  const id = t.id ? ` ${String(t.id)}` : '';
  return `${id}${created}\n${text}`.trim();
};

const ReadTweetInputSchema = z.object({
  id_or_url: z.string().min(1),
  include_thread: z.boolean().optional().default(false),
  thread_mode: z.enum(['author', 'conversation']).optional().default('author'),
  max_thread_tweets: z.number().int().min(1).max(80).optional().default(35),
});

export const readTweetTool: ToolDef = defineTool({
  name: 'read_tweet',
  tier: 'safe',
  description: 'Read a tweet by URL or ID (optional thread expansion).',
  guidance: 'Prefer this over browse_web for tweet content; returns sanitized text and URLs.',
  effects: ['network'],
  timeoutMs: 25_000,
  inputSchema: ReadTweetInputSchema,
  execute: async (input, ctx) => {
    interface ToolEnv extends NodeJS.ProcessEnv {
      X_BEARER_TOKEN?: string;
    }
    const env = process.env as ToolEnv;
    const token = env.X_BEARER_TOKEN?.trim() ?? '';
    if (!token) {
      return { ok: false, error: 'not_configured: set X_BEARER_TOKEN', text: '' };
    }

    const id = parseTweetId(input.id_or_url);
    if (!id) return { ok: false, error: 'invalid_tweet_id', text: '' };

    const cacheTtlMs = 5 * 60_000;
    const r = await fetchXJson({
      path: `/tweets/${encodeURIComponent(id)}`,
      bearerToken: token,
      signal: ctx.signal,
      cacheKey: `tweet:${id}`,
      cacheTtlMs,
      query: {
        expansions: X_EXPANSIONS,
        'tweet.fields': X_TWEET_FIELDS,
        'user.fields': X_USER_FIELDS,
        'media.fields': X_MEDIA_FIELDS,
      },
    });
    if (!r.ok) {
      return { ok: false, error: r.error, rateLimit: r.rateLimit, text: '' };
    }

    const json = r.json as {
      data?: {
        id?: string;
        text?: string;
        author_id?: string;
        created_at?: string;
        conversation_id?: string;
      };
      includes?: {
        users?: Array<{ id?: string; username?: string; name?: string }>;
        media?: unknown[];
      };
    };
    const data = json.data;
    const tweetText = formatTweet(data ?? {});

    const users = json.includes?.users ?? [];
    const author = users.find((u) => u.id && u.id === data?.author_id);
    const authorUsername = author?.username ? String(author.username) : undefined;
    const convId = data?.conversation_id ? String(data.conversation_id) : undefined;

    let threadText = '';
    if (input.include_thread && convId) {
      const query =
        input.thread_mode === 'author' && authorUsername
          ? `conversation_id:${convId} from:${authorUsername} -is:retweet`
          : `conversation_id:${convId}`;
      const sr = await fetchXJson({
        path: '/tweets/search/recent',
        bearerToken: token,
        signal: ctx.signal,
        cacheKey: `conv:${convId}:${input.thread_mode}:${authorUsername ?? 'any'}`,
        cacheTtlMs,
        query: {
          query,
          max_results: String(Math.min(100, Math.max(10, input.max_thread_tweets))),
          sort_order: 'recency',
          expansions: X_EXPANSIONS,
          'tweet.fields': X_TWEET_FIELDS,
          'user.fields': X_USER_FIELDS,
          'media.fields': X_MEDIA_FIELDS,
        },
      });
      if (sr.ok) {
        const sj = sr.json as { data?: Array<{ id?: string; text?: string; created_at?: string }> };
        const rows = sj.data ?? [];
        rows.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
        const formatted = rows.slice(0, input.max_thread_tweets).map((t) => formatTweet(t));
        threadText = formatted.filter(Boolean).join('\n\n');
      }
    }

    const combined = [tweetText, threadText ? `\n=== THREAD (best-effort) ===\n${threadText}` : '']
      .filter(Boolean)
      .join('\n')
      .trim();
    const wrapped = wrapExternal(`read_tweet:${id}`, combined);
    return {
      ok: true,
      id,
      ...(convId ? { conversationId: convId } : {}),
      ...(authorUsername ? { authorUsername } : {}),
      rateLimit: r.rateLimit,
      text: wrapped,
    };
  },
});

const SearchTweetsInputSchema = z.object({
  query: z.string().min(1).max(512),
  count: z.number().int().min(1).max(20).optional().default(10),
  cursor: z.string().min(1).max(200).optional(),
  sort_order: z.enum(['recency', 'relevancy']).optional().default('recency'),
});

export const searchTweetsTool: ToolDef = defineTool({
  name: 'search_tweets',
  tier: 'safe',
  description: 'Search recent tweets (7 days).',
  effects: ['network'],
  timeoutMs: 25_000,
  inputSchema: SearchTweetsInputSchema,
  execute: async (input, ctx) => {
    interface ToolEnv extends NodeJS.ProcessEnv {
      X_BEARER_TOKEN?: string;
    }
    const env = process.env as ToolEnv;
    const token = env.X_BEARER_TOKEN?.trim() ?? '';
    if (!token) {
      return { ok: false, error: 'not_configured: set X_BEARER_TOKEN', text: '' };
    }

    const cacheTtlMs = 5 * 60_000;
    const r = await fetchXJson({
      path: '/tweets/search/recent',
      bearerToken: token,
      signal: ctx.signal,
      cacheKey: `search:${input.sort_order}:${input.count}:${input.cursor ?? ''}:${input.query}`,
      cacheTtlMs,
      query: {
        query: input.query,
        max_results: String(Math.min(100, Math.max(10, input.count))),
        ...(input.cursor ? { next_token: input.cursor } : {}),
        sort_order: input.sort_order,
        expansions: X_EXPANSIONS,
        'tweet.fields': X_TWEET_FIELDS,
        'user.fields': X_USER_FIELDS,
        'media.fields': X_MEDIA_FIELDS,
      },
    });
    if (!r.ok) return { ok: false, error: r.error, rateLimit: r.rateLimit, text: '' };

    const json = r.json as {
      data?: Array<{ id?: string; text?: string; created_at?: string }>;
      meta?: { next_token?: string };
    };
    const rows = json.data ?? [];
    const max = Math.min(input.count, rows.length);
    const items = rows.slice(0, max).map((t) => formatTweet(t));
    const text = wrapExternal(`search_tweets:${input.query}`, items.join('\n\n'));
    return {
      ok: true,
      query: input.query,
      results: rows.slice(0, max),
      ...(json.meta?.next_token ? { cursor: String(json.meta.next_token) } : {}),
      rateLimit: r.rateLimit,
      text,
    };
  },
});

const ReadTimelineInputSchema = z.object({
  username: z.string().min(1).max(50),
  count: z.number().int().min(1).max(20).optional().default(10),
  cursor: z.string().min(1).max(200).optional(),
  include_replies: z.boolean().optional().default(false),
  include_retweets: z.boolean().optional().default(false),
});

export const readTimelineTool: ToolDef = defineTool({
  name: 'read_timeline',
  tier: 'safe',
  description: 'Read a user timeline by username.',
  effects: ['network'],
  timeoutMs: 25_000,
  inputSchema: ReadTimelineInputSchema,
  execute: async (input, ctx) => {
    interface ToolEnv extends NodeJS.ProcessEnv {
      X_BEARER_TOKEN?: string;
    }
    const env = process.env as ToolEnv;
    const token = env.X_BEARER_TOKEN?.trim() ?? '';
    if (!token) {
      return { ok: false, error: 'not_configured: set X_BEARER_TOKEN', text: '' };
    }

    const userRes = await resolveUserIdByUsername({
      username: input.username,
      bearerToken: token,
      signal: ctx.signal,
    });
    if (!userRes.ok) return { ok: false, error: userRes.error, text: '' };

    const exclude: string[] = [];
    if (!input.include_replies) exclude.push('replies');
    if (!input.include_retweets) exclude.push('retweets');

    const cacheTtlMs = 5 * 60_000;
    const r = await fetchXJson({
      path: `/users/${encodeURIComponent(userRes.user.id)}/tweets`,
      bearerToken: token,
      signal: ctx.signal,
      cacheKey: `timeline:${userRes.user.id}:${exclude.join(',')}:${input.count}:${input.cursor ?? ''}`,
      cacheTtlMs,
      query: {
        max_results: String(Math.min(100, Math.max(10, input.count))),
        ...(exclude.length ? { exclude: exclude.join(',') } : {}),
        ...(input.cursor ? { pagination_token: input.cursor } : {}),
        expansions: X_EXPANSIONS,
        'tweet.fields': X_TWEET_FIELDS,
        'user.fields': X_USER_FIELDS,
        'media.fields': X_MEDIA_FIELDS,
      },
    });
    if (!r.ok) return { ok: false, error: r.error, rateLimit: r.rateLimit, text: '' };

    const json = r.json as {
      data?: Array<{ id?: string; text?: string; created_at?: string }>;
      meta?: { next_token?: string };
    };
    const rows = json.data ?? [];
    const max = Math.min(input.count, rows.length);
    const items = rows.slice(0, max).map((t) => formatTweet(t));
    const text = wrapExternal(`read_timeline:${input.username}`, items.join('\n\n'));
    return {
      ok: true,
      user: userRes.user,
      results: rows.slice(0, max),
      ...(json.meta?.next_token ? { cursor: String(json.meta.next_token) } : {}),
      rateLimit: r.rateLimit,
      text,
    };
  },
});
