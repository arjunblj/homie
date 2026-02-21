import { normalizeHttpUrl } from '../util/mpp.js';

export const validateTelegramToken = async (
  token: string,
): Promise<{ ok: true; username: string } | { ok: false; reason: string }> => {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, reason: 'Token is empty.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: unknown;
      result?: { username?: unknown };
    } | null;
    if (!res.ok || body?.ok !== true) {
      const desc = typeof body?.description === 'string' ? body.description : `HTTP ${res.status}`;
      return { ok: false, reason: desc };
    }
    const username = body?.result?.username;
    if (typeof username !== 'string' || !username.trim()) {
      return { ok: false, reason: 'Token is valid but bot username was missing.' };
    }
    return { ok: true, username: username.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timer);
  }
};

export const sendTelegramTestMessage = async (
  token: string,
  chatId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: chatId,
        text: 'homie init test: your bot is connected.',
      }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: unknown;
    } | null;
    if (!res.ok || body?.ok !== true) {
      const desc = typeof body?.description === 'string' ? body.description : `HTTP ${res.status}`;
      return { ok: false, reason: desc };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timer);
  }
};

export const verifySignalDaemonHealth = async (
  daemonUrl: string,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const baseUrl = normalizeHttpUrl(daemonUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${baseUrl}/v1/about`, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timer);
  }
};

export const tryFetchSignalLinkUri = async (daemonUrl: string): Promise<string | null> => {
  const baseUrl = normalizeHttpUrl(daemonUrl);
  const probes = [`${baseUrl}/v1/qrcodelink?device_name=homie`, `${baseUrl}/v1/qrcodelink`];

  for (const probeUrl of probes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_500);
    try {
      const res = await fetch(probeUrl, { signal: controller.signal });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const json = (await res.json().catch(() => null)) as {
          uri?: unknown;
          url?: unknown;
          qrcode?: unknown;
          qrCode?: unknown;
          link?: unknown;
        } | null;
        const candidates = [json?.uri, json?.url, json?.qrcode, json?.qrCode, json?.link];
        const uri = candidates.find((item): item is string => typeof item === 'string');
        if (uri?.startsWith('sgnl://')) return uri;
      } else {
        const text = (await res.text()).trim();
        if (text.startsWith('sgnl://')) return text;
      }
    } catch {
      // Best-effort probe; ignore and try next endpoint.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};
