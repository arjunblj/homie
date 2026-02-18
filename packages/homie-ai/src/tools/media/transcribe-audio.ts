import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { defineTool } from '../define.js';

const InputSchema = z.object({
  attachmentId: z.string().min(1),
  /**
   * whisper.cpp language code, e.g. "en" or "auto".
   * Defaulting to "auto" is safer for mixed chats.
   */
  language: z.string().min(1).optional().default('auto'),
});

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

const WhisperJsonSchema = z
  .object({
    transcription: z.array(z.object({ text: z.string().optional() })).optional(),
  })
  .passthrough();

export const transcribeAudioTool = defineTool({
  name: 'transcribe_audio',
  tier: 'safe',
  description: 'Transcribe an audio attachment into text (local-first).',
  guidance: 'Use only when the user asks what an audio/voice note says.',
  timeoutMs: 180_000,
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    const a = ctx.attachments?.find((x) => x.id === input.attachmentId);
    if (!a) return `Unknown attachmentId: ${input.attachmentId}`;
    if (a.kind !== 'audio') return `Attachment ${input.attachmentId} is not audio`;

    if (!ctx.getAttachmentBytes) {
      return 'Attachment bytes not available in this runtime (no byte loader)';
    }

    const maxBytes = 25 * 1024 * 1024;
    if (typeof a.sizeBytes === 'number' && a.sizeBytes > maxBytes) {
      return `Audio too large (${a.sizeBytes} bytes); max is ${maxBytes} bytes`;
    }

    const modelPath = process.env['HOMIE_WHISPER_MODEL']?.trim() ?? '';
    if (!modelPath) {
      return 'transcribe_audio not enabled: set HOMIE_WHISPER_MODEL to a whisper.cpp .bin model path';
    }

    const cli = (process.env['HOMIE_WHISPER_CLI']?.trim() || 'whisper-cli').trim();
    const resolvedCli = Bun.which(cli) ?? (cli.includes('/') ? cli : null);
    if (!resolvedCli) {
      return `transcribe_audio not enabled: "${cli}" not found in PATH`;
    }

    const bytes = await ctx.getAttachmentBytes(input.attachmentId);
    if (bytes.byteLength > maxBytes) {
      return `Audio too large (${bytes.byteLength} bytes); max is ${maxBytes} bytes`;
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
      const onAbort = (): void => {
        try {
          proc.kill('SIGKILL');
        } catch (err) {
          // Best-effort: process may have already exited.
          void err;
        }
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });

      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      ctx.signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        return `whisper-cli failed (exit ${code}): ${stderr.trim().slice(0, 800)}`;
      }

      const jsonPath = `${outBase}.json`;
      const jsonText = await Bun.file(jsonPath).text();
      const parsed = WhisperJsonSchema.safeParse(safeJsonParse(jsonText));
      const transcription = parsed.success ? parsed.data.transcription : undefined;
      if (!transcription || transcription.length === 0) {
        return 'whisper-cli produced unexpected JSON';
      }
      const text = transcription
        .map((seg) => seg.text ?? '')
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
      return text || '(no transcript)';
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
});
