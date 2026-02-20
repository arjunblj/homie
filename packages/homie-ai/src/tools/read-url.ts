import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { sanitizeExternalContent } from '../security/contentSanitizer.js';
import { defineTool } from './define.js';
import type { ToolContext, ToolDef } from './types.js';
import { wrapExternal } from './util.js';

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

const stripZoneId = (ip: string): string => ip.split('%')[0] ?? ip;

const stripIpv6Brackets = (hostOrIp: string): string => {
  const s = hostOrIp.trim();
  if (s.startsWith('[') && s.endsWith(']') && s.length >= 2) {
    return s.slice(1, -1);
  }
  return s;
};

const parseIpv6ToBytes = (ip: string): Uint8Array | null => {
  const raw = stripZoneId(ip).toLowerCase();
  if (!raw.includes(':')) return null;
  if (raw.includes('.')) return null; // IPv4-embedded handled elsewhere.
  const parts = raw.split('::');
  if (parts.length > 2) return null;

  const head = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const tail = parts[1] ? parts[1].split(':').filter(Boolean) : [];
  if (head.some((p) => p.length > 4) || tail.some((p) => p.length > 4)) return null;

  const total = head.length + tail.length;
  const hasCompression = parts.length === 2;
  if (!hasCompression && total !== 8) return null;
  if (hasCompression && total > 8) return null;

  const fillZeros = hasCompression ? 8 - total : 0;
  const full = [...head, ...Array.from({ length: fillZeros }, () => '0'), ...tail];
  if (full.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const chunk = full[i];
    if (!chunk) return null;
    const n = Number.parseInt(chunk, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
};

const ipv4FromMappedIpv6 = (ip: string): string | null => {
  const v = stripZoneId(ip).toLowerCase();
  const dotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (dotted?.[1]) return dotted[1];

  const bytes = parseIpv6ToBytes(v);
  if (!bytes) return null;
  for (let i = 0; i < 10; i += 1) {
    if (bytes[i] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
};

const isPrivateIpv4 = (ip: string): boolean => {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === undefined || b === undefined) return false;

  // Loopback, link-local, private, CGNAT, and "this network".
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
};

const isPrivateIpv6 = (ip: string): boolean => {
  const v = stripZoneId(ip).toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80:')) return true; // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local (fc00::/7)

  // IPv4-mapped IPv6 (dotted or hex form, e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  const mappedV4 = ipv4FromMappedIpv6(v);
  if (mappedV4) return isPrivateIpv4(mappedV4);
  return false;
};

const isPrivateAddress = (hostOrIp: string): boolean => {
  const host = stripIpv6Brackets(hostOrIp).trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  const ipKind = isIP(stripZoneId(host));
  if (ipKind === 4) return isPrivateIpv4(host);
  if (ipKind === 6) return isPrivateIpv6(host);
  return false;
};

const canonicalizeUrlForVerified = (u: URL): string => {
  const c = new URL(u.toString());
  c.hash = '';
  c.hostname = stripIpv6Brackets(c.hostname).toLowerCase();
  if (c.protocol === 'http:' && c.port === '80') c.port = '';
  if (c.protocol === 'https:' && c.port === '443') c.port = '';
  if (!c.pathname) c.pathname = '/';
  return c.toString();
};

const canonicalizeUrlStringForVerified = (s: string): string | null => {
  try {
    return canonicalizeUrlForVerified(new URL(s));
  } catch {
    return null;
  }
};

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> => {
  const waitMs = Math.max(1, Math.floor(ms));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), waitMs);
      }),
    ]);
    return { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const defaultDnsLookupAll = async (hostname: string): Promise<readonly string[]> => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

const assertUrlAllowed = async (
  u: URL,
  ctx: ToolContext,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  // Block embedded credentials: they're almost never intended and often secrets.
  if (u.username || u.password) {
    return { ok: false, error: 'URLs with embedded credentials are not allowed.' };
  }

  const host = u.hostname.trim().toLowerCase();
  if (isPrivateAddress(host)) {
    return { ok: false, error: 'This URL is not allowed (private/localhost host).' };
  }

  // For hostnames, resolve and block any private IPs (DNS rebinding / metadata hosts).
  const ipKind = isIP(stripZoneId(host));
  if (ipKind === 0) {
    const lookupAll = ctx.net?.dnsLookupAll ?? defaultDnsLookupAll;
    const hostForLookup = host.endsWith('.') ? host.slice(0, -1) : host;
    if (!hostForLookup) return { ok: false, error: 'This URL is not allowed.' };

    const dnsTimeoutMs = ctx.net?.dnsTimeoutMs ?? 2000;
    const resolved = await withTimeout(lookupAll(hostForLookup), dnsTimeoutMs);
    if (!resolved.ok || resolved.value.length === 0) {
      return { ok: false, error: 'Could not resolve host.' };
    }

    for (const addr of resolved.value) {
      if (isPrivateAddress(addr)) {
        return { ok: false, error: 'This URL is not allowed (private/localhost host).' };
      }
    }
  }

  return { ok: true };
};

const readResponseTextUpToBytes = async (
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> => {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const raw = await res.text();
    // Fallback path: truncate after the fact (maxBytes is small by design).
    const clipped = new TextDecoder().decode(new TextEncoder().encode(raw).slice(0, maxBytes));
    return { text: clipped, truncated: clipped.length !== raw.length, bytesRead: clipped.length };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    const remaining = maxBytes - total;
    if (value.byteLength <= remaining) {
      chunks.push(value);
      total += value.byteLength;
    } else {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }
  }
  if (!truncated) {
    // Drain one extra read to detect truncation without reading much.
    const extra = await reader.read();
    if (!extra.done) truncated = true;
  }
  try {
    await reader.cancel();
  } catch (err) {
    // ignore
    void err;
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), truncated, bytesRead: total };
};

export const readUrlTool: ToolDef = defineTool({
  name: 'read_url',
  tier: 'safe',
  description: 'Fetch a URL and return the textual content (isolated as external input).',
  effects: ['network'],
  timeoutMs: 45_000,
  inputSchema: ReadUrlInputSchema,
  execute: async ({ url, maxBytes }, ctx) => {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('Only http(s) URLs are allowed.');
    }

    // Verified-URL policy: if the caller provides a verified allowlist, only allow URLs from it.
    const verified = ctx.verifiedUrls;
    if (verified && verified.size > 0) {
      const normalized = canonicalizeUrlForVerified(u);
      const verifiedCanonical = new Set<string>();
      for (const v of verified) {
        const c = canonicalizeUrlStringForVerified(v);
        if (c) verifiedCanonical.add(c);
      }
      if (!verifiedCanonical.has(normalized)) {
        return { ok: false, url, error: 'URL is not verified for fetching.' };
      }
    }

    const allowed = await assertUrlAllowed(u, ctx);
    if (!allowed.ok) {
      return { ok: false, url, error: allowed.error };
    }

    // Follow redirects manually so we can re-apply SSRF checks to each hop.
    const maxRedirects = 4;
    let current = u;
    for (let i = 0; i <= maxRedirects; i += 1) {
      const res = await fetch(current, { signal: ctx.signal, redirect: 'manual' });
      const loc = res.headers.get('location');
      if (loc && res.status >= 300 && res.status < 400) {
        const next = new URL(loc, current);
        const okNext = await assertUrlAllowed(next, ctx);
        if (!okNext.ok) return { ok: false, url, error: okNext.error };
        current = next;
        continue;
      }

      if (!res.ok) {
        return { ok: false, url, error: `HTTP ${res.status}` };
      }

      const contentType = res.headers.get('content-type') ?? 'unknown';
      const body = await readResponseTextUpToBytes(res, maxBytes);
      const rawText = contentType.includes('text/html') ? stripHtml(body.text) : body.text;
      const sanitized = sanitizeExternalContent(rawText);
      return {
        ok: true,
        url,
        finalUrl: current.toString(),
        contentType,
        truncated: body.truncated,
        text: wrapExternal(current.toString(), sanitized.sanitizedText),
      };
    }

    return { ok: false, url, error: `Too many redirects (>${maxRedirects})` };
  },
});
