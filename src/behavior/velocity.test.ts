import { describe, expect, test } from 'bun:test';
import type { SessionStore } from '../session/types.js';
import type { ChatId } from '../types/ids.js';
import {
  decideFromVelocity,
  looksLikeContinuation,
  measureVelocity,
  type VelocitySnapshot,
} from './velocity.js';

const makeMockSessionStore = (
  messages: Array<{ role: string; content: string; createdAtMs: number; authorId?: string }>,
): SessionStore =>
  ({
    getMessages: () => messages,
    appendMessage() {},
    estimateTokens: () => 0,
    compactIfNeeded: async () => false,
  }) as unknown as SessionStore;

describe('behavior/velocity', () => {
  test('looksLikeContinuation detects trailing patterns', () => {
    expect(looksLikeContinuation('and then...')).toBe(true);
    expect(looksLikeContinuation('I was thinking and')).toBe(true);
    expect(looksLikeContinuation('also,')).toBe(true);
    expect(looksLikeContinuation('hello')).toBe(false);
    expect(looksLikeContinuation('I agree with you.')).toBe(false);
  });

  test('decideFromVelocity skips rapid dialogues in groups', () => {
    const snap: VelocitySnapshot = {
      recentCount: 4,
      windowMs: 120_000,
      avgGapMs: 8_000,
      isBurst: true,
      isRapidDialogue: true,
      isContinuation: false,
    };
    expect(decideFromVelocity(snap, true)).toBe('skip');
    expect(decideFromVelocity(snap, false)).toBe('proceed');
  });

  test('decideFromVelocity waits on continuation', () => {
    const snap: VelocitySnapshot = {
      recentCount: 1,
      windowMs: 120_000,
      avgGapMs: 120_000,
      isBurst: false,
      isRapidDialogue: false,
      isContinuation: true,
    };
    expect(decideFromVelocity(snap, true)).toBe('wait');
    expect(decideFromVelocity(snap, false)).toBe('wait');
  });

  test('decideFromVelocity waits on group burst', () => {
    const snap: VelocitySnapshot = {
      recentCount: 4,
      windowMs: 120_000,
      avgGapMs: 15_000,
      isBurst: true,
      isRapidDialogue: false,
      isContinuation: false,
    };
    expect(decideFromVelocity(snap, true)).toBe('wait');
    expect(decideFromVelocity(snap, false)).toBe('proceed');
  });

  test('decideFromVelocity proceeds normally', () => {
    const snap: VelocitySnapshot = {
      recentCount: 1,
      windowMs: 120_000,
      avgGapMs: 120_000,
      isBurst: false,
      isRapidDialogue: false,
      isContinuation: false,
    };
    expect(decideFromVelocity(snap, true)).toBe('proceed');
    expect(decideFromVelocity(snap, false)).toBe('proceed');
  });

  test('measureVelocity returns safe defaults with no session store', () => {
    const snap = measureVelocity({
      sessionStore: undefined,
      chatId: 'cli:local' as ChatId,
      nowMs: 1000,
    });
    expect(snap.recentCount).toBe(0);
    expect(snap.isBurst).toBe(false);
    expect(snap.isRapidDialogue).toBe(false);
    expect(snap.isContinuation).toBe(false);
  });

  test('measureVelocity returns safe defaults with fewer than 2 recent messages', () => {
    const store = makeMockSessionStore([
      { role: 'user', content: 'hi', createdAtMs: 1000, authorId: 'a' },
    ]);
    const snap = measureVelocity({
      sessionStore: store,
      chatId: 'cli:local' as ChatId,
      windowMs: 120_000,
      nowMs: 2000,
    });
    expect(snap.recentCount).toBe(1);
    expect(snap.avgGapMs).toBe(120_000);
    expect(snap.isBurst).toBe(false);
  });

  test('measureVelocity detects burst: 3+ messages with <20s avg gap', () => {
    const now = 100_000;
    const store = makeMockSessionStore([
      { role: 'user', content: 'a', createdAtMs: now - 30_000, authorId: 'x' },
      { role: 'user', content: 'b', createdAtMs: now - 20_000, authorId: 'x' },
      { role: 'user', content: 'c', createdAtMs: now - 10_000, authorId: 'x' },
    ]);
    const snap = measureVelocity({
      sessionStore: store,
      chatId: 'cli:local' as ChatId,
      windowMs: 120_000,
      nowMs: now,
    });
    expect(snap.recentCount).toBe(3);
    expect(snap.isBurst).toBe(true);
    expect(snap.isRapidDialogue).toBe(false);
  });

  test('measureVelocity detects rapid dialogue: 2+ unique authors, <15s avg gap', () => {
    const now = 100_000;
    const store = makeMockSessionStore([
      { role: 'user', content: 'a', createdAtMs: now - 20_000, authorId: 'alice' },
      { role: 'user', content: 'b', createdAtMs: now - 10_000, authorId: 'bob' },
      { role: 'user', content: 'c', createdAtMs: now - 2_000, authorId: 'alice' },
    ]);
    const snap = measureVelocity({
      sessionStore: store,
      chatId: 'cli:local' as ChatId,
      windowMs: 120_000,
      nowMs: now,
    });
    expect(snap.recentCount).toBe(3);
    expect(snap.isRapidDialogue).toBe(true);
  });

  test('measureVelocity detects continuation in last message', () => {
    const now = 100_000;
    const store = makeMockSessionStore([
      { role: 'user', content: 'first part', createdAtMs: now - 10_000, authorId: 'x' },
      { role: 'user', content: 'and also...', createdAtMs: now - 5_000, authorId: 'x' },
    ]);
    const snap = measureVelocity({
      sessionStore: store,
      chatId: 'cli:local' as ChatId,
      windowMs: 120_000,
      nowMs: now,
    });
    expect(snap.isContinuation).toBe(true);
  });

  test('measureVelocity excludes messages outside the window', () => {
    const now = 200_000;
    const store = makeMockSessionStore([
      { role: 'user', content: 'old', createdAtMs: 10_000, authorId: 'x' },
      { role: 'user', content: 'old2', createdAtMs: 20_000, authorId: 'x' },
      { role: 'user', content: 'old3', createdAtMs: 30_000, authorId: 'x' },
      { role: 'user', content: 'recent', createdAtMs: now - 5_000, authorId: 'x' },
    ]);
    const snap = measureVelocity({
      sessionStore: store,
      chatId: 'cli:local' as ChatId,
      windowMs: 60_000,
      nowMs: now,
    });
    expect(snap.recentCount).toBe(1);
    expect(snap.isBurst).toBe(false);
  });

  test('measureVelocity ignores assistant messages', () => {
    const now = 100_000;
    const store = makeMockSessionStore([
      { role: 'user', content: 'hi', createdAtMs: now - 10_000, authorId: 'x' },
      { role: 'assistant', content: 'hello!', createdAtMs: now - 8_000 },
      { role: 'user', content: 'ok', createdAtMs: now - 5_000, authorId: 'x' },
    ]);
    const snap = measureVelocity({
      sessionStore: store,
      chatId: 'cli:local' as ChatId,
      windowMs: 120_000,
      nowMs: now,
    });
    expect(snap.recentCount).toBe(2);
  });
});
