import type { PersonRecord } from '../types.js';
import { extractMdSection, normalizeMdBody } from './sections.js';

const isEffectivelyEmpty = (s: string): boolean => {
  const t = s.trim();
  return !t || t === '(empty)';
};

export const renderPersonProfileMd = (opts: {
  person: PersonRecord;
  capsuleHuman?: string | undefined;
  capsuleAuto?: string | undefined;
  publicStyleHuman?: string | undefined;
  publicStyleAuto?: string | undefined;
  notes?: string | undefined;
}): string => {
  const { person } = opts;
  const capsuleHuman = normalizeMdBody(opts.capsuleHuman ?? '');
  const capsuleAuto = normalizeMdBody(opts.capsuleAuto ?? '');
  const publicStyleHuman = normalizeMdBody(opts.publicStyleHuman ?? '');
  const publicStyleAuto = normalizeMdBody(opts.publicStyleAuto ?? '');
  const notes = normalizeMdBody(opts.notes ?? '');

  const fm = [
    '---',
    `id: ${String(person.id)}`,
    `channel: ${person.channel}`,
    `channelUserId: ${person.channelUserId}`,
    `displayName: ${person.displayName}`,
    `relationshipStage: ${person.relationshipStage}`,
    `relationshipScore: ${person.relationshipScore}`,
    `updatedAtMs: ${person.updatedAtMs}`,
    '---',
    '',
  ].join('\n');

  return [
    fm,
    `# ${person.displayName}`,
    '',
    '## Capsule',
    capsuleHuman || '(empty)\n',
    '## CapsuleAuto',
    capsuleAuto || '(empty)\n',
    '## PublicStyle',
    publicStyleHuman || '(empty)\n',
    '## PublicStyleAuto',
    publicStyleAuto || '(empty)\n',
    '## Notes',
    notes || '(empty)\n',
  ].join('\n');
};

export const extractPersonNotesFromExisting = (existingMd: string): string => {
  return extractMdSection(existingMd, 'Notes');
};

export const extractPersonCapsuleFromExisting = (existingMd: string): string => {
  const human = extractMdSection(existingMd, 'Capsule');
  if (!isEffectivelyEmpty(human)) return human;
  const auto = extractMdSection(existingMd, 'CapsuleAuto');
  return isEffectivelyEmpty(auto) ? '' : auto;
};

export const extractPersonCapsuleHumanFromExisting = (existingMd: string): string => {
  const human = extractMdSection(existingMd, 'Capsule');
  return isEffectivelyEmpty(human) ? '' : human;
};

export const extractPersonPublicStyleFromExisting = (existingMd: string): string => {
  const human = extractMdSection(existingMd, 'PublicStyle');
  if (!isEffectivelyEmpty(human)) return human;
  const auto = extractMdSection(existingMd, 'PublicStyleAuto');
  return isEffectivelyEmpty(auto) ? '' : auto;
};

export const extractPersonPublicStyleHumanFromExisting = (existingMd: string): string => {
  const human = extractMdSection(existingMd, 'PublicStyle');
  return isEffectivelyEmpty(human) ? '' : human;
};
