import type { Tool } from 'ai';

import { calculatorTool } from './calculator.js';
import { datetimeTool } from './datetime.js';
import { readUrlTool } from './read-url.js';
import type { TieredTool, ToolRegistry, ToolTier } from './types.js';
import { webSearchTool } from './web-search.js';

export interface CreateToolRegistryOptions {
  enableDangerous?: boolean;
}

const byTier = (defs: TieredTool[]): ToolRegistry => {
  const all: Record<string, Tool> = {};
  const byTier: ToolRegistry['byTier'] = { safe: {}, restricted: {}, dangerous: {} };

  for (const def of defs) {
    all[def.name] = def.tool;
    byTier[def.tier][def.name] = def.tool;
  }

  return { all, byTier };
};

export const createToolRegistry = (_options: CreateToolRegistryOptions = {}): ToolRegistry => {
  const defs: TieredTool[] = [
    { name: 'datetime', tier: 'safe', tool: datetimeTool },
    { name: 'calculator', tier: 'safe', tool: calculatorTool },
    { name: 'read_url', tier: 'safe', tool: readUrlTool },
    { name: 'web_search', tier: 'safe', tool: webSearchTool },
  ];

  return byTier(defs);
};

export const getToolsForTier = (
  registry: ToolRegistry,
  tiers: ToolTier[],
): Record<string, Tool> => {
  const out: Record<string, Tool> = {};
  for (const tier of tiers) {
    Object.assign(out, registry.byTier[tier]);
  }
  return out;
};
