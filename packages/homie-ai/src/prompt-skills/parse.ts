import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { IncomingMessage } from '../agent/types.js';

export type PromptSkillScope = 'dm' | 'group' | 'both';

export interface PromptSkillIndex {
  /** Skill name (AgentSkills spec). Must match the directory name. */
  readonly name: string;
  readonly description: string;

  /** Absolute path to the SKILL.md file. */
  readonly filePath: string;

  /** Absolute path to the skill directory (parent of SKILL.md). */
  readonly skillDir: string;

  /** Homie-only tuning knobs (optional in frontmatter). */
  readonly scope: PromptSkillScope;
  readonly alwaysInclude: boolean;
  readonly keywords: readonly string[];
  readonly priority: number;

  /** Markdown body below the frontmatter, read at index time. */
  readonly body: string;
}

const AgentSkillsNameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const HomiePromptSkillTuningSchema = z
  .object({
    scope: z.enum(['dm', 'group', 'both']).optional(),
    alwaysInclude: z.boolean().optional(),
    keywords: z.array(z.string().min(1)).optional(),
    priority: z.number().int().optional(),
  })
  .strict()
  .optional();

const PromptSkillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(AgentSkillsNameRegex, 'Expected lowercase letters/numbers/hyphens only'),
    description: z.string().min(1).max(1024),
    homie: HomiePromptSkillTuningSchema,
  })
  .strict();

export class PromptSkillParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PromptSkillParseError';
  }
}

export interface ParsedSkillMarkdown {
  readonly frontmatter: unknown;
  readonly body: string;
}

const splitFrontmatter = (raw: string): ParsedSkillMarkdown => {
  const text = raw.replace(/\r\n/gu, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: undefined, body: raw.trim() };

  const end = text.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new PromptSkillParseError('Unterminated YAML frontmatter (missing closing ---)');
  }

  const yamlText = text.slice(4, end + 1);
  const body = text.slice(end + '\n---\n'.length).trim();
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(yamlText) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PromptSkillParseError(`Invalid YAML frontmatter: ${msg}`);
  }
  return { frontmatter, body };
};

export const parsePromptSkillIndex = (opts: {
  dirName: string;
  skillDir: string;
  filePath: string;
  markdown: string;
}): PromptSkillIndex => {
  const { frontmatter, body } = splitFrontmatter(opts.markdown);
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new PromptSkillParseError(
      'Missing YAML frontmatter with required fields: name, description',
    );
  }

  const parsed = PromptSkillFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    throw new PromptSkillParseError(`Invalid frontmatter: ${parsed.error.message}`);
  }

  const name = parsed.data.name;
  if (name !== opts.dirName) {
    throw new PromptSkillParseError(
      `Frontmatter name "${name}" must match directory name "${opts.dirName}"`,
    );
  }

  const tuning = parsed.data.homie ?? undefined;
  const scope: PromptSkillScope = tuning?.scope ?? 'both';
  const alwaysInclude = tuning?.alwaysInclude ?? false;
  const keywords = tuning?.keywords ?? [];
  const priority = tuning?.priority ?? 100;

  if (!body.trim()) {
    throw new PromptSkillParseError('SKILL.md body is empty');
  }

  return {
    name,
    description: parsed.data.description,
    filePath: opts.filePath,
    skillDir: opts.skillDir,
    scope,
    alwaysInclude,
    keywords,
    priority,
    body,
  };
};

const normalize = (s: string): string => s.trim().toLowerCase();

const matchesKeyword = (textNorm: string, kw: string): boolean => {
  const k = normalize(kw);
  if (!k) return false;
  return textNorm.includes(k);
};

export const selectPromptSkills = (opts: {
  msg: IncomingMessage;
  query: string;
  indexed: readonly PromptSkillIndex[];
  maxSelected?: number | undefined;
}): PromptSkillIndex[] => {
  const { msg, indexed } = opts;
  const maxSelected = opts.maxSelected ?? 5;
  const queryNorm = normalize(opts.query);

  const inScope = indexed.filter((s) => {
    if (msg.isGroup) return s.scope === 'group' || s.scope === 'both';
    return s.scope === 'dm' || s.scope === 'both';
  });

  const selected: PromptSkillIndex[] = [];
  const seen = new Set<string>();

  const consider = (s: PromptSkillIndex): void => {
    if (seen.has(s.name)) return;
    seen.add(s.name);
    selected.push(s);
  };

  for (const s of inScope) {
    if (s.alwaysInclude) consider(s);
  }

  if (queryNorm) {
    for (const s of inScope) {
      if (s.alwaysInclude) continue;
      if (!s.keywords.length) continue;
      if (s.keywords.some((kw) => matchesKeyword(queryNorm, kw))) consider(s);
    }
  }

  return selected
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, maxSelected));
};
