import * as p from '@clack/prompts';
import type { IdentityDraft } from 'homie-interview-core';
import pc from 'picocolors';

import type { ProviderAvailability } from '../../llm/detect.js';
import { truncateText } from '../../util/format.js';

const detectionHint = (ok: boolean, detail?: string): string => {
  if (ok) return pc.green(`✓ ${detail ?? 'detected'}`);
  return pc.dim(`○ ${detail ?? 'not detected'}`);
};

export const formatDetectionLine = (label: string, ok: boolean, detail?: string): string =>
  `  ${detectionHint(ok, detail)}  ${label}`;

export const printDetectionSummary = (
  avail: ProviderAvailability,
  ollamaDetected: boolean,
): void => {
  const lines = [
    formatDetectionLine(
      'Claude Code CLI',
      avail.hasClaudeCodeCli,
      avail.hasClaudeCodeCli ? 'detected' : 'not found',
    ),
    formatDetectionLine(
      'Codex CLI',
      avail.hasCodexCli,
      avail.hasCodexCli ? (avail.hasCodexAuth ? 'logged in' : 'login required') : 'not found',
    ),
    formatDetectionLine(
      'OpenRouter key',
      avail.hasOpenRouterKey,
      avail.hasOpenRouterKey ? 'detected' : 'not found',
    ),
    formatDetectionLine(
      'Anthropic key',
      avail.hasAnthropicKey,
      avail.hasAnthropicKey ? 'detected' : 'not found',
    ),
    formatDetectionLine(
      'OpenAI key',
      avail.hasOpenAiKey,
      avail.hasOpenAiKey ? 'detected' : 'not found',
    ),
    formatDetectionLine(
      'MPP wallet key',
      avail.hasMppPrivateKey,
      avail.hasMppPrivateKey ? 'detected' : 'not found',
    ),
    formatDetectionLine('Ollama', ollamaDetected, ollamaDetected ? 'running' : 'not found'),
  ];
  for (const line of lines) {
    p.log.message(line);
  }
};

export const formatIdentityPreview = (draft: IdentityDraft, name: string): string => {
  const cols = process.stdout.columns ?? 80;
  const maxWidth = Math.max(40, Math.min(cols - 10, 90));
  const divider = pc.dim('─'.repeat(Math.min(maxWidth, 50)));
  const bullet = pc.dim('·');

  const traitLines = draft.personality.traits
    .slice(0, 6)
    .map((t) => `  ${bullet} ${truncateText(t, maxWidth - 6)}`);
  if (draft.personality.traits.length > 6) {
    traitLines.push(pc.dim(`  + ${draft.personality.traits.length - 6} more`));
  }

  const voiceLines = draft.personality.voiceRules
    .slice(0, 4)
    .map((r) => `  ${bullet} ${truncateText(r, maxWidth - 6)}`);
  if (draft.personality.voiceRules.length > 4) {
    voiceLines.push(pc.dim(`  + ${draft.personality.voiceRules.length - 4} more`));
  }

  const soulPreview = draft.soulMd
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 3)
    .map((l) => `  ${truncateText(l.trim(), maxWidth - 4)}`)
    .join('\n');

  const sections = [
    `${pc.bold('Personality traits')}`,
    traitLines.join('\n'),
    divider,
    `${pc.bold('Voice & style')}`,
    voiceLines.join('\n'),
  ];

  if (draft.personality.antiPatterns.length > 0) {
    const antiLines = draft.personality.antiPatterns
      .slice(0, 3)
      .map((a) => `  ${pc.dim('✗')} ${truncateText(a, maxWidth - 6)}`);
    if (draft.personality.antiPatterns.length > 3) {
      antiLines.push(pc.dim(`  + ${draft.personality.antiPatterns.length - 3} more`));
    }
    sections.push(
      divider,
      `${pc.bold('Anti-patterns')} ${pc.dim(`(things ${name} won't do)`)}`,
      antiLines.join('\n'),
    );
  }

  sections.push(divider, `${pc.bold('Soul')} ${pc.dim('(preview)')}`, soulPreview);

  return sections.join('\n');
};
