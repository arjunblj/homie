import { z } from 'zod';

export const AttachmentKindSchema = z.enum(['image', 'audio', 'video', 'file']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const AttachmentMetaSchema = z
  .object({
    id: z.string().min(1),
    kind: AttachmentKindSchema,
    mime: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    fileName: z.string().min(1).optional(),
    sha256: z.string().min(1).optional(),
    /**
     * Caption/transcript produced by the channel or by tools.
     * Persist this, not raw bytes.
     */
    derivedText: z.string().min(1).optional(),
  })
  .strip();

export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

/**
 * Runtime-only attachment handle. May include a byte-loader for tools, but this
 * must never be persisted to SQLite.
 */
export interface IncomingAttachment extends AttachmentMeta {
  readonly getBytes?: (() => Promise<Uint8Array>) | undefined;
}

export const kindFromMime = (mime: string | undefined): AttachmentKind => {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'file';
};

const ATTACHMENT_LABELS: Record<AttachmentKind, string> = {
  image: 'a photo',
  audio: 'a voice message',
  video: 'a video',
  file: 'a file',
};

export const describeAttachmentForModel = (a: AttachmentMeta): string => {
  if (a.derivedText?.trim()) return a.derivedText.trim();
  const label = ATTACHMENT_LABELS[a.kind] ?? 'an attachment';
  if (a.fileName) return `[sent ${label}: ${a.fileName}]`;
  return `[sent ${label}]`;
};

export const sanitizeAttachmentsForSession = (
  attachments: readonly IncomingAttachment[] | undefined,
): AttachmentMeta[] | undefined => {
  if (!attachments || attachments.length === 0) return undefined;
  const out: AttachmentMeta[] = [];
  for (const a of attachments) {
    const parsed = AttachmentMetaSchema.safeParse(a);
    if (!parsed.success) continue;
    out.push(parsed.data);
  }
  return out.length ? out : undefined;
};
