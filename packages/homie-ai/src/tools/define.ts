import type { z } from 'zod';

import type { ToolContext, ToolDef, ToolEffect, ToolTier } from './types.js';

const toError = (reason: unknown, fallback: string): Error => {
  if (reason instanceof Error) return reason;
  return new Error(String(reason ?? fallback));
};

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

      const controller = new AbortController();
      const onParentAbort = (): void => {
        controller.abort(toError(ctx.signal.reason, 'Aborted'));
      };
      if (ctx.signal.aborted) onParentAbort();
      else ctx.signal.addEventListener('abort', onParentAbort, { once: true });

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          controller.abort(new Error(`Tool ${options.name} timed out`));
        }, options.timeoutMs);
      }

      const exec = Promise.resolve(
        options.execute(parsed.data, {
          ...ctx,
          signal: controller.signal,
        }),
      );
      const abort = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(toError(controller.signal.reason, 'Aborted'));
          return;
        }
        controller.signal.addEventListener(
          'abort',
          () => {
            reject(toError(controller.signal.reason, 'Aborted'));
          },
          { once: true },
        );
      });
      try {
        return await Promise.race([exec, abort]);
      } finally {
        if (timer) clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onParentAbort);
        // Avoid unhandled rejections if the tool settles after we raced.
        void exec.catch(() => undefined);
      }
    },
  };
};
