import { describe, expect, test } from 'bun:test';
import { deriveBehaviorInsights } from '../behavior/insights.js';
import { createDefaultConfig } from '../config/defaults.js';
import type { Lesson } from '../memory/types.js';
import type {
  SessionMessage,
  SessionNote,
  SessionStore,
  UpsertSessionNoteResult,
} from '../session/types.js';
import { asChatId } from '../types/ids.js';
import { log } from '../util/logger.js';
import { createBehaviorInsightsHook } from './behaviorInsights.js';

const makeSessionStore = (messagesByChat: Map<string, SessionMessage[]>): SessionStore => {
  const notesByChat = new Map<string, Map<string, SessionNote>>();

  return {
    appendMessage() {},
    getMessages(chatId, limit = 200) {
      const all = messagesByChat.get(String(chatId)) ?? [];
      return all.slice(Math.max(0, all.length - limit));
    },
    estimateTokens() {
      return 0;
    },
    async compactIfNeeded() {
      return false;
    },
    upsertNote({ chatId, key, content, nowMs }): UpsertSessionNoteResult {
      const chatKey = String(chatId);
      const byKey = notesByChat.get(chatKey) ?? new Map<string, SessionNote>();
      const prev = byKey.get(key);
      const note: SessionNote = prev
        ? { ...prev, content, updatedAtMs: nowMs }
        : { chatId, key, content, createdAtMs: nowMs, updatedAtMs: nowMs };
      byKey.set(key, note);
      notesByChat.set(chatKey, byKey);
      return { note, truncated: false };
    },
    getNote(chatId, key) {
      return notesByChat.get(String(chatId))?.get(key) ?? null;
    },
    listNotes(chatId, limit = 200) {
      const items = [...(notesByChat.get(String(chatId))?.values() ?? [])];
      return items.slice(0, Math.max(0, limit));
    },
  };
};

describe('hooks/behaviorInsights', () => {
  test('logs behavior_insights lessons on session end', async () => {
    const now = Date.now();
    const chatId = asChatId('signal:group:1');
    const cfg = createDefaultConfig('/tmp/proj');
    cfg.behavior.sleep = {
      enabled: true,
      timezone: 'UTC',
      startLocal: '23:00',
      endLocal: '07:00',
    };

    const messages: SessionMessage[] = [
      // Group rapid dialogue window (10m)
      { chatId, role: 'user', content: 'a', createdAtMs: now - 20_000, authorId: 'u1' },
      { chatId, role: 'user', content: 'b', createdAtMs: now - 15_000, authorId: 'u2' },
      { chatId, role: 'user', content: 'c', createdAtMs: now - 10_000, authorId: 'u1' },
      { chatId, role: 'user', content: 'd', createdAtMs: now - 5_000, authorId: 'u2' },
      { chatId, role: 'user', content: 'e', createdAtMs: now - 3_000, authorId: 'u1' },
      { chatId, role: 'user', content: 'f', createdAtMs: now - 1_000, authorId: 'u2' },

      // Slop in recent assistant outputs.
      { chatId, role: 'assistant', content: 'Great question.', createdAtMs: now - 30_000 },
      {
        chatId,
        role: 'assistant',
        content: "That's really interesting!",
        createdAtMs: now - 25_000,
      },
      { chatId, role: 'assistant', content: 'I hope this helps.', createdAtMs: now - 22_000 },
    ];

    const sessionStore = makeSessionStore(new Map([[String(chatId), messages]]));

    const logged: Lesson[] = [];
    const memoryStore = {
      async logLesson(l: Lesson) {
        logged.push(l);
      },
      async getLessons() {
        return [];
      },
    } as const;

    const hook = createBehaviorInsightsHook({
      config: cfg,
      // Cast is OK for tests; hook only uses getLessons/logLesson.
      memoryStore: memoryStore as unknown as import('../memory/store.js').MemoryStore,
      sessionStore,
      logger: log.child({ component: 'test' }),
    });

    await hook.onSessionEnd?.({ chatId });

    expect(logged.some((l) => l.category === 'behavior_insights')).toBe(true);
    expect(logged.some((l) => l.category === 'behavior_insights_group')).toBe(true);
    expect(logged.every((l) => typeof l.rule === 'string' && l.rule.length > 0)).toBe(true);
    expect(logged.length).toBeLessThanOrEqual(3);
  });

  test('dedupes recently logged rules', async () => {
    const now = Date.now();
    const chatId = asChatId('signal:group:1');
    const cfg = createDefaultConfig('/tmp/proj');
    cfg.behavior.sleep = {
      enabled: true,
      timezone: 'UTC',
      startLocal: '23:00',
      endLocal: '07:00',
    };

    const messages: SessionMessage[] = [
      { chatId, role: 'assistant', content: 'Great question.', createdAtMs: now - 30_000 },
      {
        chatId,
        role: 'assistant',
        content: "That's really interesting!",
        createdAtMs: now - 25_000,
      },
      { chatId, role: 'assistant', content: 'I hope this helps.', createdAtMs: now - 22_000 },
    ];
    const sessionStore = makeSessionStore(new Map([[String(chatId), messages]]));

    const derived = deriveBehaviorInsights({
      config: cfg,
      isGroup: true,
      messages,
      nowMs: now,
    });
    const ruleToDedup = derived[0]?.rule ?? '';
    expect(ruleToDedup.length).toBeGreaterThan(0);

    const existing: Lesson[] = [
      {
        category: 'behavior_insights',
        rule: ruleToDedup,
        content: 'x',
        type: 'pattern',
        confidence: 0.8,
        createdAtMs: now - 2 * 86_400_000,
      },
    ];

    const logged: Lesson[] = [];
    const memoryStore = {
      async logLesson(l: Lesson) {
        logged.push(l);
      },
      async getLessons() {
        return existing;
      },
    } as const;

    const hook = createBehaviorInsightsHook({
      config: cfg,
      memoryStore: memoryStore as unknown as import('../memory/store.js').MemoryStore,
      sessionStore,
      logger: log.child({ component: 'test' }),
    });

    await hook.onSessionEnd?.({ chatId });

    // Same rule should not be logged again within the 7d dedupe window.
    expect(logged.some((l) => l.rule === ruleToDedup)).toBe(false);
  });

  test('skips CLI chat IDs', async () => {
    const now = Date.now();
    const chatId = asChatId('cli:local');
    const cfg = createDefaultConfig('/tmp/proj');

    const messages: SessionMessage[] = [
      { chatId, role: 'assistant', content: 'Great question.', createdAtMs: now - 30_000 },
      {
        chatId,
        role: 'assistant',
        content: "That's really interesting!",
        createdAtMs: now - 25_000,
      },
      { chatId, role: 'assistant', content: 'I hope this helps.', createdAtMs: now - 22_000 },
    ];
    const sessionStore = makeSessionStore(new Map([[String(chatId), messages]]));

    const logged: Lesson[] = [];
    const memoryStore = {
      async logLesson(l: Lesson) {
        logged.push(l);
      },
      async getLessons() {
        return [];
      },
    } as const;

    const hook = createBehaviorInsightsHook({
      config: cfg,
      memoryStore: memoryStore as unknown as import('../memory/store.js').MemoryStore,
      sessionStore,
      logger: log.child({ component: 'test' }),
    });

    await hook.onSessionEnd?.({ chatId });
    expect(logged.length).toBe(0);
  });
});
