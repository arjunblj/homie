import type { IncomingMessage } from '../agent/types.js';
import type { PromptSkillIndex } from './types.js';

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

  // Always-include first, then keyword triggers.
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
