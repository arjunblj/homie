import type { IdentityDraft } from '../../interview/schemas.js';

const toOneLine = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const stripInlineMarkdown = (value: string): string => {
  return (
    value
      // [text](url) -> text
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
      // `code` -> code
      .replace(/`([^`]+)`/gu, '$1')
      // drop common emphasis markers
      .replace(/[*_~]/gu, '')
  );
};

const extractTextFromMarkdown = (md: string, maxLines: number): string[] => {
  const out: string[] = [];
  let inFence = false;

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (line.startsWith('#')) continue;

    const cleaned = toOneLine(
      stripInlineMarkdown(
        line
          .replace(/^>\s*/gu, '')
          .replace(/^[-*+]\s+/gu, '')
          .replace(/^\d+\.\s+/gu, ''),
      ),
    );
    if (!cleaned) continue;

    out.push(cleaned);
    if (out.length >= maxLines) break;
  }

  return out;
};

export const suggestTelegramBotUsername = (friendName: string): string => {
  const slugRaw = friendName
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_|_$/gu, '');

  // Telegram username rules are strict; this is only a suggestion for BotFather.
  // 5-32 chars, letters/numbers/underscore, and bots must end with "bot".
  const suffix = '_bot';
  const maxLen = 32;
  const minLen = 5;

  let slug = slugRaw;
  if (!slug || !/^[a-z]/u.test(slug)) slug = `homie_${slug}`.replace(/^_+/gu, '');
  slug = slug.replace(/^_+/gu, '').replace(/_+$/gu, '');

  const maxBaseLen = Math.max(1, maxLen - suffix.length);
  const base = slug.slice(0, maxBaseLen) || 'homie';
  const candidate = `${base}${suffix}`;
  if (candidate.length < minLen) return 'homie_bot';
  return candidate.slice(0, maxLen);
};

export const extractTelegramBotDescription = (
  draft: IdentityDraft | null,
  friendName: string,
): string => {
  const fallback = `${friendName} — a friend on Telegram.`;
  if (!draft?.soulMd) return fallback;

  const lines = extractTextFromMarkdown(draft.soulMd, 4);
  const joined = toOneLine(lines.join(' '));
  const desc = joined.slice(0, 512).trim();
  return desc || fallback;
};

export const extractTelegramBotShortDescription = (
  draft: IdentityDraft | null,
  friendName: string,
): string => {
  if (draft?.personality?.traits?.length) {
    const trait = toOneLine(stripInlineMarkdown(draft.personality.traits[0] ?? ''));
    const candidate = toOneLine(`${friendName} — ${trait}`);
    if (candidate.length <= 120 && candidate !== `${friendName} —`) return candidate;
  }
  return toOneLine(friendName).slice(0, 120) || 'Homie';
};
