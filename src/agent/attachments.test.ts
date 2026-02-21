import { describe, expect, test } from 'bun:test';

import {
  type AttachmentMeta,
  describeAttachmentForModel,
  type IncomingAttachment,
  kindFromMime,
  sanitizeAttachmentsForSession,
} from './attachments.js';

describe('kindFromMime', () => {
  test('detects image types', () => {
    expect(kindFromMime('image/jpeg')).toBe('image');
    expect(kindFromMime('image/png')).toBe('image');
  });
  test('detects audio types', () => {
    expect(kindFromMime('audio/ogg')).toBe('audio');
  });
  test('detects video types', () => {
    expect(kindFromMime('video/mp4')).toBe('video');
  });
  test('defaults to file', () => {
    expect(kindFromMime('application/pdf')).toBe('file');
    expect(kindFromMime(undefined)).toBe('file');
  });
});

describe('sanitizeAttachmentsForSession', () => {
  test('strips getBytes from IncomingAttachment', () => {
    const incoming: IncomingAttachment[] = [
      {
        id: 'a1',
        kind: 'image',
        mime: 'image/jpeg',
        getBytes: async () => new Uint8Array([1, 2, 3]),
      },
    ];
    const result = sanitizeAttachmentsForSession(incoming);
    expect(result).toBeDefined();
    expect(result?.length).toBe(1);
    expect(result?.[0]?.id).toBe('a1');
    expect((result?.[0] as { getBytes?: unknown } | undefined)?.getBytes).toBeUndefined();
  });

  test('drops invalid attachments', () => {
    const bad = [{ id: '', kind: 'image' }] as unknown as IncomingAttachment[];
    expect(sanitizeAttachmentsForSession(bad)).toBeUndefined();
  });

  test('returns undefined for empty array', () => {
    expect(sanitizeAttachmentsForSession([])).toBeUndefined();
    expect(sanitizeAttachmentsForSession(undefined)).toBeUndefined();
  });
});

describe('describeAttachmentForModel', () => {
  test('preserves attachment label even when derivedText is present', () => {
    const a: AttachmentMeta = { id: 'a1', kind: 'image', derivedText: 'sunset over NYC' };
    expect(describeAttachmentForModel(a)).toBe('[sent a photo] sunset over NYC');
  });

  test('generates natural description for image', () => {
    const a: AttachmentMeta = { id: 'a1', kind: 'image' };
    expect(describeAttachmentForModel(a)).toBe('[sent a photo]');
  });

  test('includes fileName when available', () => {
    const a: AttachmentMeta = { id: 'a1', kind: 'file', fileName: 'report.pdf' };
    expect(describeAttachmentForModel(a)).toBe('[sent a file: report.pdf]');
  });

  test('generates natural description for audio', () => {
    const a: AttachmentMeta = { id: 'a1', kind: 'audio' };
    expect(describeAttachmentForModel(a)).toBe('[sent a voice message]');
  });
});
