import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { errorFields, log } from '../util/logger.js';
import { PromptSkillParseError, parsePromptSkillIndex, splitFrontmatter } from './parse.js';
import type { PromptSkillIndex } from './types.js';

const isPathInside = (parent: string, child: string): boolean => {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
  return c.startsWith(prefix);
};

export const getPromptSkillsDirFromSkillsDir = (skillsDir: string): string => {
  return path.join(skillsDir, 'prompt');
};

export const readPromptSkillBody = (skill: PromptSkillIndex): string => {
  const raw = readFileSync(skill.filePath, 'utf-8');
  const { body } = splitFrontmatter(raw);
  return body.trim();
};

export async function indexPromptSkillsFromDirectory(
  promptSkillsDir: string,
  opts?: {
    /**
     * If provided, reject reading prompt skills from outside this base directory.
     * This is the main privacy/safety invariant for prompt skills: they must be
     * explicit, local config, not an arbitrary path on disk.
     */
    allowedBaseDir?: string | undefined;
    /**
     * If true, throw on the first parse/validation error. Default: false (skip invalid).
     */
    throwOnError?: boolean | undefined;
  },
): Promise<PromptSkillIndex[]> {
  const logger = log.child({ component: 'prompt_skill_loader' });

  if (opts?.allowedBaseDir && !isPathInside(opts.allowedBaseDir, promptSkillsDir)) {
    throw new Error(
      `promptSkillsDir must be within allowed base dir (${promptSkillsDir} vs ${opts.allowedBaseDir})`,
    );
  }

  if (!existsSync(promptSkillsDir)) return [];

  const entries = readdirSync(promptSkillsDir, { withFileTypes: true });
  const out: PromptSkillIndex[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(promptSkillsDir, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    try {
      const markdown = readFileSync(skillPath, 'utf-8');
      out.push(
        parsePromptSkillIndex({
          dirName: entry.name,
          skillDir,
          filePath: skillPath,
          markdown,
        }),
      );
    } catch (err) {
      if (opts?.throwOnError) throw err;

      // Malformed skill — skip without crashing the agent
      const message = err instanceof PromptSkillParseError ? err.message : undefined;
      logger.warn('index_failed', {
        skill: entry.name,
        ...(message ? { message } : {}),
        ...errorFields(err),
      });
    }
  }

  return out.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}
