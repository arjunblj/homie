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
  const persona = formatPersonaReminder(identity.personality).trim();
  const headLines = (text: string, lines: number): string =>
    text.split('\n').slice(0, lines).join('\n');
  const tailLines = (text: string, lines: number): string =>
    text.split('\n').slice(lines).join('\n');

  // Layered packing keeps identity anchors durable under token pressure.
  const sections: Array<{ label: string; content: string; minTokens: number; maxTokens: number }> =
    [
      {
        label: 'LAYER 0: PERSONA ANCHORS',
        content: truncateToTokenBudget(persona, 220),
        minTokens: 140,
        maxTokens: 220,
      },
      ...(identity.agentsDoc?.trim()
        ? [
            {
              label: 'LAYER 0.5: AGENTS EXTENSIONS',
              content: truncateToTokenBudget(identity.agentsDoc.trim(), 400),
              minTokens: 0,
              maxTokens: 400,
            },
          ]
        : []),
      ...(identity.examplesDoc?.trim()
        ? [
            {
              label: 'LAYER 0.6: EXAMPLES (TONE REFERENCE ONLY)',
              content: truncateToTokenBudget(
                [
                  'Examples are for tone reference only. Never copy them verbatim.',
                  '',
                  identity.examplesDoc.trim(),
                ].join('\n'),
                300,
              ),
              minTokens: 0,
              maxTokens: 300,
            },
          ]
        : []),
      {
        label: 'LAYER 1: OPERATOR RELATIONSHIP CORE',
        content: truncateToTokenBudget(identity.user.trim(), 260),
        minTokens: 180,
        maxTokens: 260,
      },
      {
        label: 'LAYER 2: STYLE CORE',
        content: truncateToTokenBudget(headLines(identity.style.trim(), 24), 420),
        minTokens: 250,
        maxTokens: 420,
      },
      {
        label: 'LAYER 3: SOUL CORE',
        content: truncateToTokenBudget(headLines(identity.soul.trim(), 26), 520),
        minTokens: 280,
        maxTokens: 520,
      },
      {
        label: 'LAYER 4: STYLE DETAILS',
        content: tailLines(identity.style.trim(), 24),
        minTokens: 0,
        maxTokens,
      },
      {
        label: 'LAYER 5: SOUL DETAILS',
        content: tailLines(identity.soul.trim(), 26),
        minTokens: 0,
        maxTokens,
      },
    ];

  const header = '=== OPENHOMIE IDENTITY LAYERS ===';
  const headerTokens = estimateTokens(header);
  let remaining = Math.max(0, maxTokens - headerTokens);

  const rendered: string[] = [header];
  const minTokensFrom = (idx: number): number =>
    sections.slice(idx).reduce((acc, s) => acc + Math.max(0, s.minTokens), 0);
  for (const [i, s] of sections.entries()) {
    if (remaining <= 0) break;
    const reservedForLater = minTokensFrom(i + 1);
    const maxAllowed = Math.max(0, remaining - reservedForLater);
    if (maxAllowed <= 0 && s.minTokens <= 0) continue;
    if (maxAllowed < s.minTokens) break;

    const budget = Math.min(s.maxTokens, Math.max(s.minTokens, maxAllowed));
    const content = truncateToTokenBudget(s.content.trim(), budget);
    if (!content) continue;
    rendered.push(`\n=== ${s.label} ===\n${content}`);
    remaining = Math.max(
      0,
      remaining - estimateTokens(content) - estimateTokens(`\n=== ${s.label} ===\n`),
    );
  }

  return rendered.join('\n').trim();
};
