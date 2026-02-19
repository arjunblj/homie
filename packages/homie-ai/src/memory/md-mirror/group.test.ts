import { describe, expect, test } from 'bun:test';

import { asChatId } from '../../types/ids.js';
import {
  extractGroupCapsuleFromExisting,
  extractGroupCapsuleHumanFromExisting,
  extractGroupNotesFromExisting,
  renderGroupCapsuleMd,
} from './group.js';

describe('md-mirror/group', () => {
  test('renderGroupCapsuleMd includes frontmatter and sections', () => {
    const md = renderGroupCapsuleMd({
      chatId: asChatId('signal:group:abc'),
      capsuleHuman: 'A fun group',
      capsuleAuto: 'Auto group summary',
      updatedAtMs: 99999,
      notes: 'Created last week',
    });

    expect(md).toContain('chatId: signal:group:abc');
    expect(md).toContain('updatedAtMs: 99999');
    expect(md).toContain('## Capsule');
    expect(md).toContain('A fun group');
    expect(md).toContain('## CapsuleAuto');
    expect(md).toContain('Auto group summary');
    expect(md).toContain('## Notes');
    expect(md).toContain('Created last week');
  });

  test('renderGroupCapsuleMd shows (empty) for missing sections', () => {
    const md = renderGroupCapsuleMd({
      chatId: asChatId('signal:group:abc'),
      updatedAtMs: 1000,
    });
    expect(md).toContain('(empty)');
  });

  test('extractGroupCapsuleFromExisting prefers human over auto', () => {
    const md = ['## Capsule', 'Human capsule.', '## CapsuleAuto', 'Auto capsule.'].join('\n');
    expect(extractGroupCapsuleFromExisting(md)).toBe('Human capsule.');
  });

  test('extractGroupCapsuleFromExisting falls back to auto', () => {
    const md = ['## Capsule', '(empty)', '## CapsuleAuto', 'Fallback.'].join('\n');
    expect(extractGroupCapsuleFromExisting(md)).toBe('Fallback.');
  });

  test('extractGroupCapsuleFromExisting returns empty when both are empty', () => {
    const md = ['## Capsule', '(empty)', '## CapsuleAuto', ''].join('\n');
    expect(extractGroupCapsuleFromExisting(md)).toBe('');
  });

  test('extractGroupCapsuleHumanFromExisting returns only human section', () => {
    const md = ['## Capsule', 'Human only.', '## CapsuleAuto', 'Auto.'].join('\n');
    expect(extractGroupCapsuleHumanFromExisting(md)).toBe('Human only.');
  });

  test('extractGroupNotesFromExisting returns notes', () => {
    const md = ['## Notes', 'Group started in Jan.'].join('\n');
    expect(extractGroupNotesFromExisting(md)).toBe('Group started in Jan.');
  });
});
