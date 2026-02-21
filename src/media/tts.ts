import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type TtsSynthesisResult =
  | {
      ok: true;
      mime: string;
      filename: string;
      bytes: Uint8Array;
      asVoiceNote?: boolean | undefined;
    }
  | { ok: false; error: string };

export interface TtsSynthesizer {
  synthesizeVoiceNote(
    text: string,
    opts: { signal?: AbortSignal | undefined },
  ): Promise<TtsSynthesisResult>;
}

interface ToolEnv extends NodeJS.ProcessEnv {
  OPENHOMIE_PIPER_BIN?: string | undefined;
  OPENHOMIE_PIPER_MODEL?: string | undefined;
  OPENHOMIE_FFMPEG_BIN?: string | undefined;
}

const env = process.env as ToolEnv;

const readFileBytes = async (p: string): Promise<Uint8Array> => {
  const buf = await Bun.file(p).arrayBuffer();
  return new Uint8Array(buf);
};

const resolveBin = (name: string): string | null =>
  Bun.which(name) ?? (name.includes('/') ? name : null);

export const createPiperTtsSynthesizer = (
  envOverride?: NodeJS.ProcessEnv | undefined,
): TtsSynthesizer => {
  const e = (envOverride ?? env) as ToolEnv;
  return {
    async synthesizeVoiceNote(text, opts) {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, error: 'empty_text' };

      const modelPath = e.OPENHOMIE_PIPER_MODEL?.trim() ?? '';
      if (!modelPath) return { ok: false, error: 'not_enabled: set OPENHOMIE_PIPER_MODEL' };

      const piperName = (e.OPENHOMIE_PIPER_BIN?.trim() || 'piper').trim();
      const piperBin = resolveBin(piperName);
      if (!piperBin) return { ok: false, error: `not_enabled: "${piperName}" not found in PATH` };

      const ffmpegName = (e.OPENHOMIE_FFMPEG_BIN?.trim() || 'ffmpeg').trim();
      const ffmpegBin = resolveBin(ffmpegName);

      const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-tts-'));
      try {
        const wavPath = path.join(tmp, 'voice.wav');
        const oggPath = path.join(tmp, 'voice.ogg');

        // Piper reads text from stdin, writes WAV.
        const p = Bun.spawn([piperBin, '-m', modelPath, '-f', wavPath], {
          stdin: 'pipe',
          stdout: 'ignore',
          stderr: 'pipe',
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (!p.stdin) return { ok: false, error: 'piper_failed: no stdin' };
        p.stdin.write(`${trimmed}\n`);
        p.stdin.end();
        const exit = await p.exited;
        if (exit !== 0) {
          const err = await new Response(p.stderr).text().catch(() => '');
          return {
            ok: false,
            error: `piper_failed: ${err.trim().slice(0, 400) || `exit ${exit}`}`,
          };
        }

        // Telegram "voice" prefers OGG/OPUS. If ffmpeg is present, transcode.
        if (ffmpegBin) {
          const f = Bun.spawn(
            [ffmpegBin, '-y', '-i', wavPath, '-c:a', 'libopus', '-b:a', '24k', oggPath],
            { stdout: 'ignore', stderr: 'pipe', ...(opts.signal ? { signal: opts.signal } : {}) },
          );
          const fexit = await f.exited;
          if (fexit === 0) {
            return {
              ok: true,
              mime: 'audio/ogg',
              filename: 'voice.ogg',
              bytes: await readFileBytes(oggPath),
              asVoiceNote: true,
            };
          }
          // Fall through to WAV if transcoding fails.
        }

        return {
          ok: true,
          mime: 'audio/wav',
          filename: 'voice.wav',
          bytes: await readFileBytes(wavPath),
          asVoiceNote: false,
        };
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  };
};
