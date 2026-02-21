import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { errorFields, log } from '../../util/logger.js';
import { defineTool } from '../define.js';
import type { ToolDef } from '../types.js';

const LANGUAGE_RE = /^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/iu;

const InputSchema = z.object({
  attachmentId: z.string().min(1),
  /**
   * whisper.cpp language code, e.g. "en" or "auto".
   * Defaulting to "auto" is safer for mixed chats.
   */
  language: z
    .string()
    .trim()
    .min(1)
    .optional()
    .default('auto')
    .transform((s) => s.toLowerCase())
    .refine((s) => LANGUAGE_RE.test(s), 'Invalid language code'),
});

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch (_err) {
    return null;
  }
}

const WhisperJsonSchema = z
  .object({
    transcription: z.array(z.object({ text: z.string().optional() })).optional(),
  })
  .passthrough();

const toError = (reason: unknown, fallback: string): Error => {
  if (reason instanceof Error) return reason;
  return new Error(String(reason ?? fallback));
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
  } catch (_err) {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const transcribeAudioTool: ToolDef = defineTool({
  name: 'transcribe_audio',
  tier: 'safe',
  description: 'Transcribe an audio attachment into text (local-first).',
  guidance: 'Use only when the user asks what an audio/voice note says.',
  effects: ['subprocess', 'filesystem'],
  timeoutMs: 180_000,
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    const logger = log.child({ component: 'tool_transcribe_audio' });
    const a = ctx.attachments?.find((x) => x.id === input.attachmentId);
    if (!a) return 'Attachment not found';
    if (a.kind !== 'audio') return 'Attachment is not audio';

    if (!ctx.getAttachmentBytes) {
      return 'transcribe_audio unavailable';
    }

    const maxBytes = 25 * 1024 * 1024;
    if (typeof a.sizeBytes === 'number' && a.sizeBytes > maxBytes) {
      return 'Audio too large';
    }

    const modelPath = process.env.OPENHOMIE_WHISPER_MODEL?.trim() ?? '';
    if (!modelPath) {
      return 'transcribe_audio unavailable';
    }

    const cli = (process.env.OPENHOMIE_WHISPER_CLI?.trim() || 'whisper-cli').trim();
    const resolvedCli = Bun.which(cli) ?? (cli.includes('/') ? cli : null);
    if (!resolvedCli) {
      return 'transcribe_audio unavailable';
    }

    const bytes = await ctx.getAttachmentBytes(input.attachmentId);
    if (bytes.byteLength > maxBytes) {
      return 'Audio too large';
    }

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-whisper-'));
    try {
      const ext = a.mime?.includes('ogg')
        ? 'ogg'
        : a.mime?.includes('mpeg')
          ? 'mp3'
          : a.mime?.includes('wav')
            ? 'wav'
            : 'audio';
      const audioPath = path.join(tmp, `input.${ext}`);
      const outBase = path.join(tmp, 'out');
      await writeFile(audioPath, bytes);

      const args: string[] = [
        resolvedCli,
        '-m',
        modelPath,
        '-f',
        audioPath,
        '-oj',
        '-of',
        outBase,
        '-np',
      ];
      if (input.language && input.language !== 'auto') {
        args.push('-l', input.language);
      } else {
        args.push('-l', 'auto');
      }

      const proc = Bun.spawn(args, {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const killWithGrace = async (): Promise<void> => {
        try {
          proc.kill('SIGTERM');
        } catch (err) {
          void err;
        }
        const exitedAfterTerm = await withTimeout(proc.exited, 250);
        if (!exitedAfterTerm.ok) {
          try {
            proc.kill('SIGKILL');
          } catch (err) {
            void err;
          }
        }
        // Best-effort: don't hang forever if the runtime doesn't resolve proc.exited.
        await withTimeout(proc.exited, 2000);
      };

      let abortListener: (() => void) | undefined;
      const abort = new Promise<never>((_, reject) => {
        abortListener = () => {
          void killWithGrace().finally(() => {
            reject(toError(ctx.signal.reason, 'Aborted'));
          });
        };
        if (ctx.signal.aborted) abortListener();
        else ctx.signal.addEventListener('abort', abortListener, { once: true });
      });

      const exitTimeoutMs = 170_000;
      const stderrPromise = new Response(proc.stderr).text();
      const codePromise = proc.exited;
      let code: number;
      try {
        code = await Promise.race([
          abort,
          (async () => {
            const exited = await withTimeout(codePromise, exitTimeoutMs);
            if (!exited.ok) {
              await killWithGrace();
              throw new Error('whisper exit timeout');
            }
            return exited.value;
          })(),
        ]);
      } finally {
        if (abortListener) ctx.signal.removeEventListener('abort', abortListener);
      }
      // Ensure we don't leak stderr reads if we bail out early.
      void stderrPromise.catch(() => undefined);

      const stderrRes = await withTimeout(stderrPromise, 5000);
      const stderr = stderrRes.ok ? stderrRes.value : '';
      if (code !== 0) {
        logger.debug('whisper_cli_failed', { exitCode: code, stderrLen: stderr.length });
        return 'transcribe_audio failed';
      }

      const jsonPath = `${outBase}.json`;
      const jsonText = await Bun.file(jsonPath).text();
      const parsed = WhisperJsonSchema.safeParse(safeJsonParse(jsonText));
      const transcription = parsed.success ? parsed.data.transcription : undefined;
      if (!transcription || transcription.length === 0) {
        logger.debug('whisper_json_unexpected');
        return 'transcribe_audio failed';
      }
      const text = transcription
        .map((seg) => seg.text ?? '')
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
      return text || '(no transcript)';
    } catch (err) {
      logger.debug('transcribe_failed', errorFields(err));
      return 'transcribe_audio failed';
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
});
