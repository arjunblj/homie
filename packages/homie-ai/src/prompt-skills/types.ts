export type PromptSkillScope = 'dm' | 'group' | 'both';

export interface PromptSkillIndex {
  /**
   * Skill name (AgentSkills spec). Must match the directory name.
   * Example: "group-discipline"
   */
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
}
