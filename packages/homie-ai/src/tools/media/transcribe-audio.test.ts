import { describe, expect, test } from 'bun:test';

import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingAttachment } from '../../agent/attachments.js';
import { transcribeAudioTool } from './transcribe-audio.js';

describe('media tools: transcribe_audio', () => {
  test('returns not-enabled message when HOMIE_WHISPER_MODEL is unset', async () => {
    const prev = process.env.HOMIE_WHISPER_MODEL;
    try {
      delete process.env.HOMIE_WHISPER_MODEL;
      const attachments: IncomingAttachment[] = [{ id: 'a1', kind: 'audio', mime: 'audio/ogg' }];
      const out = await transcribeAudioTool.execute(
        { attachmentId: 'a1', language: 'auto' },
        {
          now: new Date(),
          signal: new AbortController().signal,
          attachments,
          getAttachmentBytes: async () => new Uint8Array([1, 2, 3]),
        },
      );
      expect(String(out)).toContain('unavailable');
    } finally {
      if (prev === undefined) delete process.env.HOMIE_WHISPER_MODEL;
      else process.env.HOMIE_WHISPER_MODEL = prev;
    }
  });

  test('rejects invalid language codes', async () => {
    await expect(
      transcribeAudioTool.execute(
        { attachmentId: 'a1', language: 'en__' },
        {
          now: new Date(),
          signal: new AbortController().signal,
          attachments: [{ id: 'a1', kind: 'audio', mime: 'audio/ogg' }],
          getAttachmentBytes: async () => new Uint8Array([1, 2, 3]),
        },
      ),
    ).rejects.toThrow('Invalid tool input');
  });

  test('kills subprocess and cleans temp dir on abort', async () => {
    const prevModel = process.env.HOMIE_WHISPER_MODEL;
    const prevCli = process.env.HOMIE_WHISPER_CLI;
    const prevTmpdir = process.env.TMPDIR;

    const testTmp = await mkdtemp(path.join(os.tmpdir(), 'homie-transcribe-test-'));
    process.env.TMPDIR = testTmp;

    const cliPath = path.join(testTmp, 'fake-whisper.sh');
    await writeFile(
      cliPath,
      [
        '#!/bin/sh',
        "trap '' TERM",
        'while true; do',
        '  sleep 1',
        'done',
        '',
      ].join('\n'),
    );
    await chmod(cliPath, 0o755);

    process.env.HOMIE_WHISPER_MODEL = '/dev/null';
    process.env.HOMIE_WHISPER_CLI = cliPath;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new Error('timeout')), 25);
    try {
      const attachments: IncomingAttachment[] = [{ id: 'a1', kind: 'audio', mime: 'audio/ogg' }];
      await expect(
        transcribeAudioTool.execute(
          { attachmentId: 'a1', language: 'auto' },
          {
            now: new Date(),
            signal: controller.signal,
            attachments,
            getAttachmentBytes: async () => new Uint8Array([1, 2, 3]),
          },
        ),
      ).rejects.toThrow('timeout');

      const deadline = Date.now() + 3000;
      // defineTool rejects immediately on abort; give the tool a moment to kill + rm its temp dir.
      // We isolate TMPDIR so this is deterministic.
      while (Date.now() < deadline) {
        const entries = await readdir(testTmp);
        const whisperDirs = entries.filter((e) => e.startsWith('homie-whisper-'));
        if (whisperDirs.length === 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const entries = await readdir(testTmp);
      expect(entries.some((e) => e.startsWith('homie-whisper-'))).toBe(false);
    } finally {
      clearTimeout(t);
      if (prevModel === undefined) delete process.env.HOMIE_WHISPER_MODEL;
      else process.env.HOMIE_WHISPER_MODEL = prevModel;
      if (prevCli === undefined) delete process.env.HOMIE_WHISPER_CLI;
      else process.env.HOMIE_WHISPER_CLI = prevCli;
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
      await rm(testTmp, { recursive: true, force: true });
    }
  });
});
