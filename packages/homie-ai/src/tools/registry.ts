import { calculatorTool } from './calculator.js';
import { datetimeTool } from './datetime.js';
import { readUrlTool } from './read-url.js';
import { loadSkillsFromDirectory } from './skill-loader.js';
import type { ToolDef, ToolRegistry, ToolTier } from './types.js';
import { webSearchTool } from './web-search.js';

export interface CreateToolRegistryOptions {
  builtins?: boolean;
  skillsDir?: string;
}

function byTier(defs: ToolDef[]): ToolRegistry {
  const all: Record<string, ToolDef> = {};
  const tiers: ToolRegistry['byTier'] = { safe: {}, restricted: {}, dangerous: {} };

  for (const def of defs) {
    all[def.name] = def;
    tiers[def.tier][def.name] = def;
  }

  return { all, byTier: tiers };
}

export async function createToolRegistry(
  options: CreateToolRegistryOptions = {},
): Promise<ToolRegistry> {
  const defs: ToolDef[] = [];

  // Built-in tools
  if (options.builtins !== false) {
    defs.push(datetimeTool, calculatorTool, readUrlTool, webSearchTool);
  }

  // Filesystem skills
  if (options.skillsDir) {
    const skills = await loadSkillsFromDirectory(options.skillsDir);
    for (const skill of skills) {
      defs.push(...skill.tools);
    }
  }

  return byTier(defs);
}

export function getToolsForTier(registry: ToolRegistry, tiers: ToolTier[]): ToolDef[] {
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
}
