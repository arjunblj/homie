import { z } from 'zod';

import type { ToolDef } from '../types.js';

const InputSchema = z
  .object({
    prompt: z.string().min(1).max(1200),
    width: z.number().int().min(256).max(1536).optional().default(1024),
    height: z.number().int().min(256).max(1536).optional().default(1024),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    model: z.string().min(1).max(50).optional(),
  })
  .strict();

const fetchWithTimeout = async (
  url: URL,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Response> => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = (): void => {
    if (controller.signal.aborted) return;
    controller.abort(signal.reason ?? new Error('aborted'));
  };
  try {
    let combinedSignal: AbortSignal;
    if (typeof AbortSignal.any === 'function') {
      combinedSignal = AbortSignal.any([signal, controller.signal]);
    } else {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      combinedSignal = controller.signal;
    }
    return await fetch(url, { ...init, signal: combinedSignal });
  } finally {
    clearTimeout(t);
    signal.removeEventListener('abort', onAbort);
  }
};

export const generateImageTool: ToolDef = {
  name: 'generate_image',
  tier: 'restricted',
  description: 'Generate an image from a prompt and return it as an attachment.',
  effects: ['network'],
  inputSchema: InputSchema,
  timeoutMs: 45_000,
  execute: async (input, ctx) => {
    const parsed = InputSchema.parse(input);
    const url = new URL(
      `https://image.pollinations.ai/prompt/${encodeURIComponent(parsed.prompt)}`,
    );
    url.searchParams.set('width', String(parsed.width));
    url.searchParams.set('height', String(parsed.height));
    url.searchParams.set('nologo', 'true');
    if (parsed.seed !== undefined) url.searchParams.set('seed', String(parsed.seed));
    if (parsed.model) url.searchParams.set('model', parsed.model);

    const res = await fetchWithTimeout(url, { headers: { Accept: 'image/*' } }, 40_000, ctx.signal);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return `generate_image_failed: HTTP ${res.status} ${detail.trim().slice(0, 200)}`.trim();
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const maxBytes = 12 * 1024 * 1024;
    if (bytes.byteLength > maxBytes) {
      return `generate_image_failed: too_large (${bytes.byteLength} bytes)`;
    }
    const contentType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]?.trim();
    const ext =
      contentType === 'image/png'
        ? 'png'
        : contentType === 'image/webp'
          ? 'webp'
          : contentType === 'image/gif'
            ? 'gif'
            : 'jpg';

    return {
      text: 'Generated 1 image attachment.',
      media: [
        {
          kind: 'image',
          mime: contentType || 'image/jpeg',
          bytes,
          fileName: `image.${ext}`,
          altText: parsed.prompt,
        },
      ],
    };
  },
};
