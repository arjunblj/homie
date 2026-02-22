import { type Tool as AiTool, tool } from 'ai';

import type { ToolContext, ToolDef } from '../tools/types.js';

const wrapToolOutputText = (toolName: string, text: string): string => {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<external') || trimmed.startsWith('<tool_output')) return text;
  const safeName = toolName.replace(/[^a-z0-9:_-]/giu, '_');
  const safeText = text.replaceAll('</tool_output>', '</tool_output_>');
  return `<tool_output name="${safeName}">\n${safeText}\n</tool_output>`;
};

export const toolDefsToAiTools = (
  defs: readonly ToolDef[] | undefined,
  rootSignal: AbortSignal | undefined,
  toolContext: Omit<ToolContext, 'now' | 'signal'> | undefined,
): Record<string, AiTool> => {
  const out: Record<string, AiTool> = {};
  if (!defs) return out;

  for (const def of defs) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input) => {
        const timeoutMs = def.timeoutMs ?? 60_000;
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );

        const onAbort = (): void => {
          if (controller.signal.aborted) return;
          const reason = rootSignal?.reason;
          controller.abort(reason ?? new Error('Aborted'));
        };
        if (rootSignal) {
          if (rootSignal.aborted) onAbort();
          else rootSignal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          const result = await def.execute(input, {
            ...(toolContext ?? {}),
            now: new Date(),
            signal: controller.signal,
          });
          return typeof result === 'string' ? wrapToolOutputText(def.name, result) : result;
        } finally {
          clearTimeout(timer);
          if (rootSignal) rootSignal.removeEventListener('abort', onAbort);
        }
      },
    });
  }
  return out;
};
