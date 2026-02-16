import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDef, ToolTier } from './types.js';

const ManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tier: z.enum(['safe', 'restricted', 'dangerous']).default('restricted'),
  version: z.string().optional(),
});

export interface LoadedSkill {
  readonly name: string;
  readonly tier: ToolTier;
  readonly tools: readonly ToolDef[];
}

export async function loadSkillsFromDirectory(skillsDir: string): Promise<LoadedSkill[]> {
  if (!existsSync(skillsDir)) return [];

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = path.join(skillsDir, entry.name);
    const indexPath = path.join(skillPath, 'index.ts');

    if (!existsSync(indexPath)) continue;

    try {
      const mod = (await import(indexPath)) as { tools?: ToolDef[] };
      if (!Array.isArray(mod.tools)) continue;

      let tier: ToolTier = 'restricted';
      let name = entry.name;
      const manifestPath = path.join(skillPath, 'manifest.json');
      if (existsSync(manifestPath)) {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
        const parsed = ManifestSchema.safeParse(raw);
        if (parsed.success) {
          name = parsed.data.name;
          tier = parsed.data.tier;
        }
      }

      const toolsWithTier = mod.tools.map((t) => ({
        ...t,
        tier: t.tier ?? tier,
      }));

      skills.push({ name, tier, tools: toolsWithTier });
    } catch {
      // Malformed skill — skip without crashing the agent
    }
  }

  return skills;
}
