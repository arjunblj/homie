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
  const sections: Array<{ label: string; content: string; minTokens: number }> = [
    {
      label: 'LAYER 0: PERSONA ANCHORS',
      content: truncateToTokenBudget(persona, 220),
      minTokens: 180,
    },
    ...(identity.agentsDoc?.trim()
      ? [
          {
            label: 'LAYER 0.5: AGENTS EXTENSIONS',
            content: truncateToTokenBudget(identity.agentsDoc.trim(), 400),
            minTokens: 220,
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
            minTokens: 180,
          },
        ]
      : []),
    {
      label: 'LAYER 1: OPERATOR RELATIONSHIP CORE',
      content: truncateToTokenBudget(identity.user.trim(), 260),
      minTokens: 220,
    },
    {
      label: 'LAYER 2: STYLE CORE',
      content: truncateToTokenBudget(headLines(identity.style.trim(), 24), 420),
      minTokens: 320,
    },
    {
      label: 'LAYER 3: SOUL CORE',
      content: truncateToTokenBudget(headLines(identity.soul.trim(), 26), 520),
      minTokens: 380,
    },
    {
      label: 'LAYER 4: STYLE DETAILS',
      content: tailLines(identity.style.trim(), 24),
      minTokens: 260,
    },
    {
      label: 'LAYER 5: SOUL DETAILS',
      content: tailLines(identity.soul.trim(), 26),
      minTokens: 320,
    },
  ];

  const header = '=== OPENHOMIE IDENTITY LAYERS ===';
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
