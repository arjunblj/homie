import { z } from 'zod';

import { resolveOllamaBaseUrl } from '../../llm/ollama.js';
import { defineTool } from '../define.js';

const InputSchema = z.object({
  attachmentId: z.string().min(1),
  prompt: z
    .string()
    .min(1)
    .optional()
    .default('Describe this image briefly in a casual friend tone.'),
});

export const describeImageTool = defineTool({
  name: 'describe_image',
  tier: 'safe',
  description: 'Describe an image attachment (local-first via Ollama vision when available).',
  guidance: 'Use only when the user asks what is in an image/screenshot/meme.',
  timeoutMs: 60_000,
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    const a = ctx.attachments?.find((x) => x.id === input.attachmentId);
    if (!a) return `Unknown attachmentId: ${input.attachmentId}`;
    if (a.kind !== 'image') return `Attachment ${input.attachmentId} is not an image`;

    // Best-effort: if the channel already provided a caption, return it.
    if (a.derivedText?.trim()) return a.derivedText.trim();

    const maxBytes = 10 * 1024 * 1024;
    if (typeof a.sizeBytes === 'number' && a.sizeBytes > maxBytes) {
      return `Image too large (${a.sizeBytes} bytes); max is ${maxBytes} bytes`;
    }

    const model = (process.env['HOMIE_OLLAMA_VISION_MODEL'] ?? '').trim();
    const baseUrl = model ? resolveOllamaBaseUrl({ requireLocalhost: true }) : null;
    if (!model || !baseUrl) {
      return 'describe_image not enabled (set HOMIE_OLLAMA_VISION_MODEL and provide image bytes)';
    }

    if (!ctx.getAttachmentBytes) {
      return 'Attachment bytes not available in this runtime (no byte loader)';
    }
    const bytes = await ctx.getAttachmentBytes(input.attachmentId);
    if (bytes.byteLength > maxBytes) {
      return `Image too large (${bytes.byteLength} bytes); max is ${maxBytes} bytes`;
    }
    const base64 = Buffer.from(bytes).toString('base64');

    const url = new URL(baseUrl.toString());
    url.pathname = `${url.pathname}/api/chat`.replace(/\/{2,}/gu, '/');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: input.prompt, images: [base64] }],
        stream: false,
      }),
      signal: ctx.signal,
    });
    if (!res.ok) {
      return `describe_image failed (ollama status ${res.status})`;
    }
    const OllamaChatSchema = z
      .object({
        message: z.object({ content: z.string().default('') }).optional(),
      })
      .passthrough();
    const parsed = OllamaChatSchema.safeParse(await res.json());
    const text = parsed.success ? String(parsed.data.message?.content ?? '').trim() : '';
    return text || '(no description)';
  },
});
