import { z } from 'zod';

import { resolveOllamaBaseUrl } from '../../llm/ollama.js';
import { errorFields, log } from '../../util/logger.js';
import { defineTool } from '../define.js';
import type { ToolDef } from '../types.js';

const InputSchema = z.object({
  attachmentId: z.string().min(1),
  prompt: z
    .string()
    .min(1)
    .optional()
    .default('Describe this image briefly in a casual friend tone.'),
});

export const describeImageTool: ToolDef = defineTool({
  name: 'describe_image',
  tier: 'safe',
  description: 'Describe an image attachment (local-first via Ollama vision when available).',
  guidance: 'Use only when the user asks what is in an image/screenshot/meme.',
  effects: ['network'],
  timeoutMs: 60_000,
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    const logger = log.child({ component: 'tool_describe_image' });
    const a = ctx.attachments?.find((x) => x.id === input.attachmentId);
    if (!a) return 'Attachment not found';
    if (a.kind !== 'image') return 'Attachment is not an image';

    // Best-effort: if the channel already provided a caption, return it.
    if (a.derivedText?.trim()) return a.derivedText.trim();

    const maxBytes = 10 * 1024 * 1024;
    if (typeof a.sizeBytes === 'number' && a.sizeBytes > maxBytes) {
      return 'Image too large';
    }

    const model = (process.env.OPENHOMIE_OLLAMA_VISION_MODEL ?? '').trim();
    const baseUrl = model ? resolveOllamaBaseUrl({ requireLocalhost: true }) : null;
    if (!model || !baseUrl) {
      return 'describe_image unavailable';
    }

    if (!ctx.getAttachmentBytes) {
      return 'describe_image unavailable';
    }
    const bytes = await ctx.getAttachmentBytes(input.attachmentId);
    if (bytes.byteLength > maxBytes) {
      return 'Image too large';
    }
    const base64 = Buffer.from(bytes).toString('base64');

    const url = new URL(baseUrl.toString());
    url.pathname = `${url.pathname}/api/chat`.replace(/\/{2,}/gu, '/');

    try {
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
        logger.debug('ollama_non_ok', { status: res.status });
        return 'describe_image failed';
      }
      const OllamaChatSchema = z
        .object({
          message: z.object({ content: z.string().default('') }).optional(),
        })
        .passthrough();
      const parsed = OllamaChatSchema.safeParse(await res.json());
      const text = parsed.success ? String(parsed.data.message?.content ?? '').trim() : '';
      return text || '(no description)';
    } catch (err) {
      logger.debug('ollama_failed', errorFields(err));
      return 'describe_image failed';
    }
  },
});
