import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { PromptSkillIndex, PromptSkillScope } from './types.js';

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
    // Keep unknown keys out by default; if we want to support more spec fields later,
    // we can add them explicitly.
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
  readonly frontmatter: unknown | undefined;
  readonly body: string;
}

export const splitFrontmatter = (raw: string): ParsedSkillMarkdown => {
  const text = raw.replace(/\r\n/gu, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: undefined, body: raw.trim() };

  const end = text.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new PromptSkillParseError('Unterminated YAML frontmatter (missing closing ---)');
  }

  const yamlText = text.slice(4, end + 1); // keep trailing \n for nicer yaml errors
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
  const scope: PromptSkillScope = tuning?.scope ?? 'dm';
  const alwaysInclude = tuning?.alwaysInclude ?? false;
  const keywords = tuning?.keywords ?? [];
  const priority = tuning?.priority ?? 100;

  if (!body.trim()) {
    // The body is what gets injected into the prompt; an empty skill is almost always unintended.
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
  };
};
