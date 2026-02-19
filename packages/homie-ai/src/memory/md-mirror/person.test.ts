import { describe, expect, test } from 'bun:test';
import { asPersonId } from '../../types/ids.js';
import type { PersonRecord } from '../types.js';
import {
  extractPersonCapsuleFromExisting,
  extractPersonCapsuleHumanFromExisting,
  extractPersonNotesFromExisting,
  extractPersonPublicStyleFromExisting,
  extractPersonPublicStyleHumanFromExisting,
  renderPersonProfileMd,
} from './person.js';

const makePerson = (overrides?: Partial<PersonRecord>): PersonRecord => ({
  id: asPersonId('person:test'),
  displayName: 'Alice',
  channel: 'signal',
  channelUserId: '+1234567890',
  relationshipScore: 0.5,
  createdAtMs: 1000,
  updatedAtMs: 2000,
  ...overrides,
});

describe('md-mirror/person', () => {
  test('renderPersonProfileMd includes frontmatter and all sections', () => {
    const md = renderPersonProfileMd({
      person: makePerson(),
      capsuleHuman: 'Loves hiking',
      capsuleAuto: 'Auto capsule',
      publicStyleHuman: 'Chill tone',
      publicStyleAuto: 'Auto style',
      notes: 'Met at a concert',
    });

    expect(md).toContain('displayName: Alice');
    expect(md).toContain('relationshipScore: 0.5');
    expect(md).toContain('trustTier: getting_to_know');
    expect(md).toContain('## Capsule');
    expect(md).toContain('Loves hiking');
    expect(md).toContain('## CapsuleAuto');
    expect(md).toContain('Auto capsule');
    expect(md).toContain('## Notes');
    expect(md).toContain('Met at a concert');
  });

  test('renderPersonProfileMd uses trustTierOverride when set', () => {
    const md = renderPersonProfileMd({
      person: makePerson({ trustTierOverride: 'close_friend' }),
    });
    expect(md).toContain('trustTier: close_friend');
  });

  test('renderPersonProfileMd shows (empty) for missing sections', () => {
    const md = renderPersonProfileMd({ person: makePerson() });
    expect(md).toContain('(empty)');
  });

  test('extractPersonCapsuleFromExisting prefers human over auto', () => {
    const md = ['## Capsule', 'Human capsule here.', '## CapsuleAuto', 'Auto capsule here.'].join(
      '\n',
    );
    expect(extractPersonCapsuleFromExisting(md)).toBe('Human capsule here.');
  });

  test('extractPersonCapsuleFromExisting falls back to auto when human is empty', () => {
    const md = ['## Capsule', '(empty)', '## CapsuleAuto', 'Auto content.'].join('\n');
    expect(extractPersonCapsuleFromExisting(md)).toBe('Auto content.');
  });

  test('extractPersonCapsuleHumanFromExisting returns only human section', () => {
    const md = ['## Capsule', 'Human only.', '## CapsuleAuto', 'Auto.'].join('\n');
    expect(extractPersonCapsuleHumanFromExisting(md)).toBe('Human only.');
  });

  test('extractPersonPublicStyleFromExisting prefers human over auto', () => {
    const md = ['## PublicStyle', 'Human style.', '## PublicStyleAuto', 'Auto style.'].join('\n');
    expect(extractPersonPublicStyleFromExisting(md)).toBe('Human style.');
  });

  test('extractPersonPublicStyleFromExisting falls back to auto', () => {
    const md = ['## PublicStyle', '', '## PublicStyleAuto', 'Fallback style.'].join('\n');
    expect(extractPersonPublicStyleFromExisting(md)).toBe('Fallback style.');
  });

  test('extractPersonPublicStyleHumanFromExisting returns empty when human is empty', () => {
    const md = ['## PublicStyle', '(empty)', '## PublicStyleAuto', 'Auto.'].join('\n');
    expect(extractPersonPublicStyleHumanFromExisting(md)).toBe('');
  });

  test('extractPersonNotesFromExisting returns notes section', () => {
    const md = ['## Notes', 'Met at a party.', 'Likes jazz.'].join('\n');
    expect(extractPersonNotesFromExisting(md)).toBe('Met at a party.\nLikes jazz.');
  });
});
