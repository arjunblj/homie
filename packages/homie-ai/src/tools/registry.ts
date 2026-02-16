import { calculatorTool } from './calculator.js';
import { datetimeTool } from './datetime.js';
import { readUrlTool } from './read-url.js';
import { webSearchTool } from './web-search.js';
import type { ToolDef, ToolRegistry, ToolTier } from './types.js';

export interface CreateToolRegistryOptions {
  enableDangerous?: boolean;
}

const byTier = (defs: ToolDef[]): ToolRegistry => {
  const all: Record<string, ToolDef> = {};
  const byTier: ToolRegistry['byTier'] = { safe: {}, restricted: {}, dangerous: {} };

  for (const def of defs) {
    all[def.name] = def;
    byTier[def.tier][def.name] = def;
  }

  return { all, byTier };
};

export const createToolRegistry = (_options: CreateToolRegistryOptions = {}): ToolRegistry => {
  const defs: ToolDef[] = [
    datetimeTool,
    calculatorTool,
    readUrlTool,
    webSearchTool,
  ];

  return byTier(defs);
};

export const getToolsForTier = (
  registry: ToolRegistry,
  tiers: ToolTier[],
): ToolDef[] => {
  const out: ToolDef[] = [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    for (const [name, def] of Object.entries(registry.byTier[tier])) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(def);
    }
  }
  return out;
};
