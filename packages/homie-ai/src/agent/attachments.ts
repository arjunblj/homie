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
  .strict();

export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

/**
 * Runtime-only attachment handle. May include a byte-loader for tools, but this
 * must never be persisted to SQLite.
 */
export interface IncomingAttachment extends AttachmentMeta {
  readonly getBytes?: (() => Promise<Uint8Array>) | undefined;
}

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
