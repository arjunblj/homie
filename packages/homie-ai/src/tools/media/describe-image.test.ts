import { describe, expect, test } from 'bun:test';

import type { IncomingAttachment } from '../../agent/attachments.js';
import { describeImageTool } from './describe-image.js';

describe('media tools: describe_image', () => {
  test('returns derivedText when available', async () => {
    const attachments: IncomingAttachment[] = [
      { id: 'i1', kind: 'image', mime: 'image/jpeg', derivedText: 'caption here' },
    ];
    const out = await describeImageTool.execute(
      { attachmentId: 'i1', prompt: 'x' },
      {
        now: new Date(),
        signal: new AbortController().signal,
        attachments,
      },
    );
    expect(out).toBe('caption here');
  });

  test('returns not-enabled message when vision model is unset', async () => {
    const prev = process.env.HOMIE_OLLAMA_VISION_MODEL;
    try {
      delete process.env.HOMIE_OLLAMA_VISION_MODEL;
      const attachments: IncomingAttachment[] = [{ id: 'i2', kind: 'image', mime: 'image/jpeg' }];
      const out = await describeImageTool.execute(
        { attachmentId: 'i2' },
        {
          now: new Date(),
          signal: new AbortController().signal,
          attachments,
          getAttachmentBytes: async () => new Uint8Array([1, 2, 3]),
        },
      );
      expect(String(out)).toContain('unavailable');
    } finally {
      if (prev === undefined) delete process.env.HOMIE_OLLAMA_VISION_MODEL;
      else process.env.HOMIE_OLLAMA_VISION_MODEL = prev;
    }
  });
});
