import type { Tool } from 'ai';

export type ToolTier = 'safe' | 'restricted' | 'dangerous';

export interface TieredTool {
  name: string;
  tier: ToolTier;
  tool: Tool;
}

export interface ToolRegistry {
  all: Record<string, Tool>;
  byTier: Record<ToolTier, Record<string, Tool>>;
}
