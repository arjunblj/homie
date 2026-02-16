export type ToolTier = 'safe' | 'restricted' | 'dangerous';

export interface ToolContext {
  now: Date;
}

export interface ToolDef {
  name: string;
  tier: ToolTier;
  description: string;
  inputSchema: import('zod').ZodTypeAny;
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
}

export interface ToolRegistry {
  all: Record<string, ToolDef>;
  byTier: Record<ToolTier, Record<string, ToolDef>>;
}
