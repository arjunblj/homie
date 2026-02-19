import type { ChatId } from '../../types/ids.js';
import { extractMdSection, isEffectivelyEmpty, normalizeMdBody } from './sections.js';

export const renderGroupCapsuleMd = (opts: {
  chatId: ChatId;
  capsuleHuman?: string | undefined;
  capsuleAuto?: string | undefined;
  updatedAtMs: number;
  notes?: string | undefined;
}): string => {
  const capsuleHuman = normalizeMdBody(opts.capsuleHuman ?? '');
  const capsuleAuto = normalizeMdBody(opts.capsuleAuto ?? '');
  const notes = normalizeMdBody(opts.notes ?? '');

  const fm = [
    '---',
    `chatId: ${String(opts.chatId)}`,
    `updatedAtMs: ${opts.updatedAtMs}`,
    '---',
    '',
  ].join('\n');

  return [
    fm,
    `# Group ${String(opts.chatId)}`,
    '',
    '## Capsule',
    capsuleHuman || '(empty)\n',
    '## CapsuleAuto',
    capsuleAuto || '(empty)\n',
    '## Notes',
    notes || '(empty)\n',
  ].join('\n');
};

export const extractGroupNotesFromExisting = (existingMd: string): string => {
  return extractMdSection(existingMd, 'Notes');
};

export const extractGroupCapsuleFromExisting = (existingMd: string): string => {
  const human = extractMdSection(existingMd, 'Capsule');
  if (!isEffectivelyEmpty(human)) return human;
  const auto = extractMdSection(existingMd, 'CapsuleAuto');
  return isEffectivelyEmpty(auto) ? '' : auto;
};

export const extractGroupCapsuleHumanFromExisting = (existingMd: string): string => {
  const human = extractMdSection(existingMd, 'Capsule');
  return isEffectivelyEmpty(human) ? '' : human;
};
