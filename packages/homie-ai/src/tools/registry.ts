import { calculatorTool } from './calculator.js';
import { datetimeTool } from './datetime.js';
import { readUrlTool } from './read-url.js';
import { loadSkillsFromDirectory } from './skill-loader.js';
import type { ToolDef, ToolRegistry, ToolTier } from './types.js';
import { webSearchTool } from './web-search.js';

export interface CreateToolRegistryOptions {
  builtins?: boolean;
  identityDir?: string;
  skillsDir?: string;
}

function byTier(defs: ToolDef[]): ToolRegistry {
  const all: Record<string, ToolDef> = {};
  const tiers: ToolRegistry['byTier'] = { safe: {}, restricted: {}, dangerous: {} };

  for (const def of defs) {
    const existing = all[def.name];
    if (existing) {
      const a = `${existing.source ?? 'unknown'}:${existing.tier}`;
      const b = `${def.source ?? 'unknown'}:${def.tier}`;
      throw new Error(
        `Duplicate tool name "${def.name}" (${a} vs ${b}). Tool names must be unique.`,
      );
    }
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
    defs.push(
      { ...datetimeTool, source: datetimeTool.source ?? 'builtin' },
      { ...calculatorTool, source: calculatorTool.source ?? 'builtin' },
      { ...readUrlTool, source: readUrlTool.source ?? 'builtin' },
      { ...webSearchTool, source: webSearchTool.source ?? 'builtin' },
    );
  }

  // Identity tools (identityDir/tools/*)
  if (options.identityDir) {
    const identityToolsDir = `${options.identityDir.replace(/\/+$/u, '')}/tools`;
    const skills = await loadSkillsFromDirectory(identityToolsDir);
    for (const skill of skills) {
      defs.push(
        ...skill.tools.map((t) => ({
          ...t,
          source: t.source ?? 'identity',
        })),
      );
    }
  }

  // Filesystem skills
  if (options.skillsDir) {
    const skills = await loadSkillsFromDirectory(options.skillsDir);
    for (const skill of skills) {
      defs.push(
        ...skill.tools.map((t) => ({
          ...t,
          source: t.source ?? 'skill',
        })),
      );
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
