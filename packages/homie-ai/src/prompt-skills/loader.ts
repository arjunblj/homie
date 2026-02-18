import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import { errorFields, log } from '../util/logger.js';
import { truncateToTokenBudget } from '../util/tokens.js';
import type { PromptSkillIndex } from './parse.js';
import { PromptSkillParseError, parsePromptSkillIndex, selectPromptSkills } from './parse.js';

const isPathInside = (parent: string, child: string): boolean => {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
  return c.startsWith(prefix);
};

export function indexPromptSkillsFromDirectory(
  promptSkillsDir: string,
  opts?: {
    allowedBaseDir?: string | undefined;
    throwOnError?: boolean | undefined;
  },
): PromptSkillIndex[] {
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

export function buildPromptSkillsSection(opts: {
  indexed: readonly PromptSkillIndex[];
  msg: IncomingMessage;
  query: string;
  maxTokens: number;
  maxSelected?: number | undefined;
}): string {
  const selected = selectPromptSkills({
    msg: opts.msg,
    query: opts.query,
    indexed: opts.indexed,
    maxSelected: opts.maxSelected,
  });
  if (selected.length === 0) return '';

  const blocks = selected.map((s) => {
    return [`--- PROMPT SKILL: ${s.name} ---`, s.description.trim(), '', s.body.trim()].join('\n');
  });

  const section = ['=== PROMPT SKILLS (LOCAL) ===', ...blocks].join('\n\n').trim();
  return truncateToTokenBudget(section, opts.maxTokens).trim();
}
