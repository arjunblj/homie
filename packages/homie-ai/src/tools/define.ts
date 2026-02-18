import type { z } from 'zod';

import type { ToolContext, ToolDef, ToolEffect, ToolTier } from './types.js';

export interface DefineToolOptions<S extends z.ZodTypeAny> {
  name: string;
  tier: ToolTier;
  description: string;
  guidance?: string | undefined;
  effects?: readonly ToolEffect[] | undefined;
  inputSchema: S;
  timeoutMs?: number | undefined;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown;
}

export const defineTool = <S extends z.ZodTypeAny>(options: DefineToolOptions<S>): ToolDef => {
  return {
    name: options.name,
    tier: options.tier,
    description: options.description,
    ...(options.guidance ? { guidance: options.guidance } : {}),
    ...(options.effects ? { effects: options.effects } : {}),
    inputSchema: options.inputSchema,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    execute: async (input: unknown, ctx: ToolContext) => {
      const parsed = options.inputSchema.safeParse(input);
      if (!parsed.success) {
        // Throwing here is intentional: we want the model to learn the correct schema.
        throw new Error(`Invalid tool input for ${options.name}: ${parsed.error.message}`);
      }

      const exec = Promise.resolve(options.execute(parsed.data, ctx));
      const abort = new Promise<never>((_, reject) => {
        const reason = ctx.signal.reason;
        if (ctx.signal.aborted) {
          reject(reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted')));
          return;
        }
        ctx.signal.addEventListener(
          'abort',
          () => {
            const r = ctx.signal.reason;
            reject(r instanceof Error ? r : new Error(String(r ?? 'Aborted')));
          },
          { once: true },
        );
      });
      return await Promise.race([exec, abort]);
    },
  };
};
