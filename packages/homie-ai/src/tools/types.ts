export type ToolTier = 'safe' | 'restricted' | 'dangerous';

export type ToolSource = 'builtin' | 'identity' | 'skill';

export interface ToolContext {
  now: Date;
  signal: AbortSignal;
}

export interface ToolDef {
  name: string;
  tier: ToolTier;
  source?: ToolSource | undefined;
  description: string;
  guidance?: string | undefined;
  inputSchema: import('zod').ZodTypeAny;
  timeoutMs?: number | undefined;
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
}

export interface ToolRegistry {
  all: Record<string, ToolDef>;
  byTier: Record<ToolTier, Record<string, ToolDef>>;
}
