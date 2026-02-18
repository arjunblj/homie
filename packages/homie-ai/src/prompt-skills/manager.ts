import type { IncomingMessage } from '../agent/types.js';
import { truncateToTokenBudget } from '../util/tokens.js';
import { readPromptSkillBody } from './loader.js';
import { selectPromptSkills } from './select.js';
import type { PromptSkillIndex } from './types.js';

export class PromptSkillManager {
  private readonly byName = new Map<string, PromptSkillIndex>();
  private readonly bodyCache = new Map<string, string>();

  public constructor(
    private readonly opts: {
      indexed: readonly PromptSkillIndex[];
      maxTokens: number;
      maxSelected?: number | undefined;
    },
  ) {
    for (const s of opts.indexed) this.byName.set(s.name, s);
  }

  private loadBody(skill: PromptSkillIndex): string {
    const cached = this.bodyCache.get(skill.name);
    if (cached !== undefined) return cached;
    const body = readPromptSkillBody(skill);
    this.bodyCache.set(skill.name, body);
    return body;
  }

  public async buildSection(opts: { msg: IncomingMessage; query: string }): Promise<string> {
    const selected = selectPromptSkills({
      msg: opts.msg,
      query: opts.query,
      indexed: this.opts.indexed,
      maxSelected: this.opts.maxSelected,
    });
    if (selected.length === 0) return '';

    const blocks = selected.map((s) => {
      const body = this.loadBody(s);
      return [`--- PROMPT SKILL: ${s.name} ---`, s.description.trim(), '', body.trim()].join('\n');
    });

    const section = ['=== PROMPT SKILLS (LOCAL) ===', ...blocks].join('\n\n').trim();
    return truncateToTokenBudget(section, this.opts.maxTokens).trim();
  }
}
