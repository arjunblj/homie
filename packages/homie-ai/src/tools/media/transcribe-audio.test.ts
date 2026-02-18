import { describe, expect, test } from 'bun:test';

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
});
