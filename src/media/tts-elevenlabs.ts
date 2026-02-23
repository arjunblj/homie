import type { TtsSynthesisResult, TtsSynthesizer } from './tts.js';

export interface ElevenLabsVoiceSettings {
  stability: number;
  similarityBoost: number;
  speed: number;
}

export interface ElevenLabsTtsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  voiceSettings: ElevenLabsVoiceSettings;
}

const sleep = async (ms: number, signal?: AbortSignal | undefined): Promise<void> => {
  if (ms <= 0) return;
  if (!signal) {
    await Bun.sleep(ms);
    return;
  }
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
};

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const parseRetryAfterMs = (header: string | null): number | null => {
  const raw = (header ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n * 1000);
};

const looksLikeOggContainer = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= 4 &&
  bytes[0] === 0x4f &&
  bytes[1] === 0x67 &&
  bytes[2] === 0x67 &&
  bytes[3] === 0x53;

export const createElevenLabsTtsSynthesizer = (config: ElevenLabsTtsConfig): TtsSynthesizer => {
  return {
    async synthesizeVoiceNote(text, opts): Promise<TtsSynthesisResult> {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, error: 'empty_text' };

      const apiKey = config.apiKey.trim();
      const voiceId = config.voiceId.trim();
      if (!apiKey) return { ok: false, error: 'not_enabled: set ELEVENLABS_API_KEY' };
      if (!voiceId) return { ok: false, error: 'not_enabled: set tts.elevenlabs.voice_id' };

      const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`);
      url.searchParams.set('output_format', config.outputFormat);

      const body = {
        text: trimmed,
        model_id: config.modelId,
        voice_settings: {
          stability: config.voiceSettings.stability,
          similarity_boost: config.voiceSettings.similarityBoost,
          speed: config.voiceSettings.speed,
        },
      };

      const maxAttempts = 3;
      let lastStatus = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (opts.signal?.aborted) return { ok: false, error: 'cancelled' };

        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': apiKey,
            },
            body: JSON.stringify(body),
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `elevenlabs_failed: ${msg.slice(0, 300)}` };
        }

        lastStatus = res.status;
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const wantsOpus = config.outputFormat.startsWith('opus_');
          if (wantsOpus && !looksLikeOggContainer(bytes)) {
            return { ok: false, error: 'elevenlabs_unexpected_audio_container' };
          }
          return {
            ok: true,
            mime: wantsOpus ? 'audio/ogg' : 'audio/mpeg',
            filename: wantsOpus ? 'voice.ogg' : 'voice.mp3',
            bytes,
            asVoiceNote: wantsOpus,
          };
        }

        if (!isRetryableStatus(res.status) || attempt === maxAttempts) {
          const detail = await res.text().catch(() => '');
          return {
            ok: false,
            error: `elevenlabs_http_${res.status}: ${detail.trim().slice(0, 300)}`,
          };
        }

        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        await sleep(Math.max(backoffMs, retryAfterMs ?? 0), opts.signal);
      }

      return { ok: false, error: `elevenlabs_http_${lastStatus}: max retries exceeded` };
    },
  };
};
