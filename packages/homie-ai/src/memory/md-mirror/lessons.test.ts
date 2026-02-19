import { describe, expect, test } from 'bun:test';

import type { Lesson } from '../types.js';
import { renderCuratedLessonsMd } from './lessons.js';

describe('md-mirror/lessons', () => {
  test('renders empty lessons', () => {
    const md = renderCuratedLessonsMd([], 1000);
    expect(md).toContain('(none yet)');
    expect(md).toContain('updatedAtMs: 1000');
  });

  test('renders lessons with metadata', () => {
    const lessons: Lesson[] = [
      {
        category: 'tone',
        content: 'Be more casual in groups',
        type: 'observation',
        confidence: 0.85,
        createdAtMs: 1000,
      },
      {
        category: 'behavior',
        content: 'Do not double text',
        rule: 'Never send two messages in a row',
        createdAtMs: 2000,
      },
    ];

    const md = renderCuratedLessonsMd(lessons, 5000);
    expect(md).toContain('updatedAtMs: 5000');
    expect(md).toContain('Be more casual in groups');
    expect(md).toContain('type=observation');
    expect(md).toContain('confidence=0.85');
    expect(md).toContain('Never send two messages in a row');
  });

  test('prefers rule over content when rule exists', () => {
    const lessons: Lesson[] = [
      {
        category: 'x',
        content: 'raw observation text',
        rule: 'distilled rule',
        createdAtMs: 1000,
      },
    ];
    const md = renderCuratedLessonsMd(lessons, 1000);
    expect(md).toContain('distilled rule');
    expect(md).not.toContain('raw observation text');
  });
});
