import { describe, expect, test } from 'bun:test';
import { createStubMemoryStore } from '../testing/helpers.js';
import { asChatId } from '../types/ids.js';
import { assembleMemoryContext } from './context-pack.js';
import type { Lesson } from './types.js';

describe('assembleMemoryContext behavior insights', () => {
  test('injects global + group insights for group scope', async () => {
    const nowMs = Date.now();
    const globalLesson: Lesson = {
      category: 'behavior_insights',
      type: 'pattern',
      rule: 'Avoid multi-message bursts; batch thoughts into one message when possible.',
      content: 'x',
      confidence: 0.8,
      createdAtMs: nowMs,
    };
    const groupLesson: Lesson = {
      category: 'behavior_insights_group',
      type: 'pattern',
      rule: 'In rapid group back-and-forth, prefer reactions or silence; wait for a lull to reply.',
      content: 'y',
      confidence: 0.8,
      createdAtMs: nowMs,
    };

    const store = createStubMemoryStore({
      async getLessons(category?: string, _limit?: number) {
        if (category === 'behavior_insights') return [globalLesson];
        if (category === 'behavior_insights_group') return [groupLesson];
        return [];
      },
    });

    const ctx = await assembleMemoryContext({
      store,
      query: 'Should I respond now or wait?',
      chatId: asChatId('signal:group:1'),
      channelUserId: 'signal:dm:someone',
      budget: 800,
      scope: 'group',
    });

    expect(ctx.text).toContain('Behavior insights:');
    expect(ctx.text).toContain(globalLesson.rule ?? '');
    expect(ctx.text).toContain(groupLesson.rule ?? '');
  });

  test('injects only global insights for DM scope', async () => {
    const nowMs = Date.now();
    const globalLesson: Lesson = {
      category: 'behavior_insights',
      type: 'pattern',
      rule: 'Avoid slop patterns; lead with substance and concrete next step.',
      content: 'x',
      confidence: 0.8,
      createdAtMs: nowMs,
    };
    const groupLesson: Lesson = {
      category: 'behavior_insights_group',
      type: 'pattern',
      rule: 'In rapid group back-and-forth, prefer reactions or silence; wait for a lull to reply.',
      content: 'y',
      confidence: 0.8,
      createdAtMs: nowMs,
    };

    const store = createStubMemoryStore({
      async getLessons(category?: string, _limit?: number) {
        if (category === 'behavior_insights') return [globalLesson];
        if (category === 'behavior_insights_group') return [groupLesson];
        return [];
      },
    });

    const ctx = await assembleMemoryContext({
      store,
      query: 'Can you remind me what we decided?',
      chatId: asChatId('signal:dm:1'),
      channelUserId: 'signal:dm:someone',
      budget: 800,
      scope: 'dm',
    });

    expect(ctx.text).toContain('Behavior insights:');
    expect(ctx.text).toContain(globalLesson.rule ?? '');
    expect(ctx.text).not.toContain(groupLesson.rule ?? '');
  });
});
