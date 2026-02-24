import { normalizeHttpUrl } from '../util/mpp.js';

const TELEGRAM_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/u;

const normalizeTelegramToken = (token: string): string | null => {
  const trimmed = token.trim();
  if (!trimmed) return null;
  return TELEGRAM_TOKEN_PATTERN.test(trimmed) ? trimmed : null;
};

export const validateTelegramToken = async (
  token: string,
): Promise<{ ok: true; username: string } | { ok: false; reason: string }> => {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, reason: 'Token is empty.' };
  if (!normalizeTelegramToken(trimmed)) {
    return { ok: false, reason: 'Token format is invalid.' };
  }
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
  const normalizedToken = normalizeTelegramToken(token);
  if (!normalizedToken) {
    return { ok: false, reason: 'Token format is invalid.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${normalizedToken}/sendMessage`, {
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

export interface TelegramBotProfileOptions {
  token: string;
  name?: string | undefined;
  description?: string | undefined;
  shortDescription?: string | undefined;
}

export type TelegramBotProfileField = 'name' | 'description' | 'short_description';

export interface TelegramBotProfileFailure {
  field: TelegramBotProfileField;
  reason: string;
}

export type TelegramBotProfileResult =
  | { ok: true; applied: TelegramBotProfileField[]; failed: TelegramBotProfileFailure[] }
  | {
      ok: false;
      reason: string;
      applied: TelegramBotProfileField[];
      failed: TelegramBotProfileFailure[];
    };

export const configureTelegramBotProfile = async (
  opts: TelegramBotProfileOptions,
): Promise<TelegramBotProfileResult> => {
  const normalizedToken = normalizeTelegramToken(opts.token);
  if (!normalizedToken) {
    return {
      ok: false,
      reason: 'Token format is invalid.',
      applied: [],
      failed: [],
    };
  }

  const applied: TelegramBotProfileField[] = [];
  const failed: TelegramBotProfileFailure[] = [];

  const toOneLine = (value: string): string => value.replace(/\s+/gu, ' ').trim();

  const call = async (
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://api.telegram.org/bot${normalizedToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      let json: { ok?: boolean; description?: unknown } | null = null;
      try {
        const text = await res.text();
        if (text.trim()) {
          json = JSON.parse(text) as { ok?: boolean; description?: unknown };
        }
      } catch (_err) {
        // Telegram may return non-JSON errors; fall back to status code.
      }

      if (res.ok) {
        if (json?.ok === true) return { ok: true };
        const desc =
          typeof json?.description === 'string'
            ? json.description
            : 'Unexpected Telegram API response.';
        return { ok: false, reason: desc };
      }

      const desc = typeof json?.description === 'string' ? json.description : `HTTP ${res.status}`;
      return { ok: false, reason: desc };
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'));
      const msg = isAbort
        ? 'Timed out calling Telegram API.'
        : err instanceof Error
          ? err.message
          : String(err);
      return { ok: false, reason: msg };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const attempt = async (
      field: TelegramBotProfileField,
      method: string,
      body: Record<string, unknown>,
    ): Promise<void> => {
      const result = await call(method, body);
      if (result.ok) applied.push(field);
      else failed.push({ field, reason: result.reason });
    };

    const name = opts.name ? toOneLine(opts.name).slice(0, 64) : '';
    if (name) {
      await attempt('name', 'setMyName', { name });
    }

    const desc = opts.description ? toOneLine(opts.description).slice(0, 512) : '';
    if (desc) {
      await attempt('description', 'setMyDescription', { description: desc });
    }

    const short = opts.shortDescription ? toOneLine(opts.shortDescription).slice(0, 120) : '';
    if (short) {
      await attempt('short_description', 'setMyShortDescription', { short_description: short });
    }

    if (failed.length > 0) {
      return {
        ok: false,
        reason: failed[0]?.reason ?? 'Telegram profile update failed.',
        applied,
        failed,
      };
    }
    return { ok: true, applied, failed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg, applied, failed };
  }
};

export const verifySignalDaemonHealth = async (
  daemonUrl: string,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const raw = daemonUrl.trim();
  if (/^[a-z]+:\/\//iu.test(raw) && !/^https?:\/\//iu.test(raw)) {
    return { ok: false, reason: 'Signal daemon URL is invalid.' };
  }
  const baseUrl = normalizeHttpUrl(daemonUrl);
  if (!baseUrl) return { ok: false, reason: 'Signal daemon URL is invalid.' };
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
  const raw = daemonUrl.trim();
  if (/^[a-z]+:\/\//iu.test(raw) && !/^https?:\/\//iu.test(raw)) return null;
  const baseUrl = normalizeHttpUrl(daemonUrl);
  if (!baseUrl) return null;
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
    } catch (_err) {
      // Best-effort probe; ignore and try next endpoint.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};
