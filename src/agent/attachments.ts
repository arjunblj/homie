import { z } from 'zod';

export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';
const AttachmentKindSchema: z.ZodType<AttachmentKind> = z.enum(['image', 'audio', 'video', 'file']);

export interface AttachmentMeta {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly mime?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly fileName?: string | undefined;
  readonly sha256?: string | undefined;
  /**
   * Caption/transcript produced by the channel or by tools.
   * Persist this, not raw bytes.
   */
  readonly derivedText?: string | undefined;
}

export const AttachmentMetaSchema: z.ZodType<AttachmentMeta> = z
  .object({
    id: z.string().min(1),
    kind: AttachmentKindSchema,
    mime: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    fileName: z.string().min(1).optional(),
    sha256: z.string().min(1).optional(),
    derivedText: z.string().min(1).optional(),
  })
  .strip();

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
  const label = ATTACHMENT_LABELS[a.kind] ?? 'an attachment';
  const derived = a.derivedText?.trim();
  if (derived) {
    // Preserve the fact that this was an attachment even when we already have text.
    return a.fileName ? `[sent ${label}: ${a.fileName}] ${derived}` : `[sent ${label}] ${derived}`;
  }
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
