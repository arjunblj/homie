import type { IncomingAttachment } from '../agent/attachments.js';
import { kindFromMime } from '../agent/attachments.js';

export interface SignalDataMessageAttachment {
  contentType?: string;
  filename?: string;
  size?: number;
}

export const parseSignalAttachments = (
  rawAttachments: readonly SignalDataMessageAttachment[],
  timestamp: number,
): IncomingAttachment[] | undefined => {
  if (!rawAttachments.length) return undefined;
  const out: IncomingAttachment[] = rawAttachments.map((a, i) => {
    const mime = a.contentType?.trim() || undefined;
    const fileName = a.filename?.trim() || undefined;
    const sizeBytes = typeof a.size === 'number' ? a.size : undefined;
    return {
      id: `signal:${timestamp}:${i}`,
      kind: kindFromMime(mime),
      ...(mime ? { mime } : {}),
      ...(fileName ? { fileName } : {}),
      ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}),
    };
  });
  return out.length ? out : undefined;
};
