export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isLocalhostHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

export function resolveOllamaBaseUrl(
  opts?: { requireLocalhost?: boolean },
): URL | null {
  const raw = (process.env['HOMIE_OLLAMA_URL'] ?? 'http://127.0.0.1:11434').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if ((opts?.requireLocalhost ?? true) && !isLocalhostHost(url.hostname)) return null;
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url;
}

const toOllamaHealthUrl = (baseUrl: string): string => {
  const normalized = baseUrl.replace(/\/+$/u, '');
  const withoutV1 = normalized.endsWith('/v1') ? normalized.slice(0, -3) : normalized;
  return `${withoutV1}/api/version`;
};

export const probeOllama = async (baseUrl: string, fetchImpl: FetchLike): Promise<void> => {
  const url = toOllamaHealthUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 400);

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Ollama probe failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Ollama probe returned HTTP ${res.status}`);
  }
};
