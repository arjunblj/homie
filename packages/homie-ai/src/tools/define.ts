import type { z } from 'zod';

import type { ToolContext, ToolDef, ToolTier } from './types.js';

export interface DefineToolOptions<S extends z.ZodTypeAny> {
  name: string;
  tier: ToolTier;
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown;
}

export const defineTool = <S extends z.ZodTypeAny>(options: DefineToolOptions<S>): ToolDef => {
  return {
    name: options.name,
    tier: options.tier,
    description: options.description,
    inputSchema: options.inputSchema,
    execute: async (input: unknown, ctx: ToolContext) => {
      const parsed = options.inputSchema.safeParse(input);
      if (!parsed.success) {
        // Throwing here is intentional: we want the model to learn the correct schema.
        throw new Error(`Invalid tool input for ${options.name}: ${parsed.error.message}`);
      }
      return options.execute(parsed.data, ctx);
    },
  };
};
