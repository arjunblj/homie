import { estimateTokens, truncateToTokenBudget } from '../util/tokens.js';
import { formatPersonaReminder } from './personality.js';
import type { IdentityPackage } from './types.js';

export interface IdentityPromptOptions {
  maxTokens: number;
}

export const composeIdentityPrompt = (
  identity: IdentityPackage,
  options: IdentityPromptOptions,
): string => {
  const maxTokens = options.maxTokens;

  const persona = formatPersonaReminder(identity.personality);

  // Order matters: if we need to truncate, we keep these sections in priority order.
  const sections: Array<{ label: string; content: string; minTokens: number }> = [
    { label: 'PERSONALITY KEYWORDS (re-injectable)', content: persona, minTokens: 120 },
    { label: 'STYLE (voice + examples)', content: identity.style, minTokens: 600 },
    { label: 'USER (operator context)', content: identity.user, minTokens: 200 },
    { label: 'SOUL (backstory)', content: identity.soul, minTokens: 800 },
  ];

  const header = '=== HOMIE IDENTITY PACKAGE ===';
  const headerTokens = estimateTokens(header);
  let remaining = Math.max(0, maxTokens - headerTokens);

  const rendered: string[] = [header];
  for (const s of sections) {
    if (remaining <= 0) break;
    const budget = Math.min(remaining, Math.max(0, s.minTokens));
    const content = truncateToTokenBudget(s.content.trim(), budget);
    if (!content) continue;
    rendered.push(`\n=== ${s.label} ===\n${content}`);
    remaining = Math.max(0, remaining - estimateTokens(content) - estimateTokens(s.label));
  }

  return rendered.join('\n').trim();
};
