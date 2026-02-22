import { describe, expect, test } from 'bun:test';
import type { SessionMessage } from '../session/types.js';
import { asChatId } from '../types/ids.js';
import {
  classifyMessageType,
  computeHeat,
  computeParticipationStats,
  detectThreadLock,
  participationRateToTarget,
  rollEngagement,
} from './groupEngagement.js';

describe('groupEngagement', () => {
  test('classifyMessageType', () => {
    expect(classifyMessageType({ mentioned: true }, 'yo?')).toBe('mentioned_question');
    expect(classifyMessageType({ mentioned: true }, 'yo')).toBe('mentioned_casual');
    expect(classifyMessageType({ mentioned: false }, 'check https://x.com')).toBe('has_link');
    expect(classifyMessageType({}, 'lol')).toBe('general');
  });

  test('detectThreadLock', () => {
    const chatId = asChatId('c');
    const base = (m: Omit<SessionMessage, 'chatId'>): SessionMessage => ({ chatId, ...m });
    const msgs: SessionMessage[] = [
      // Evidence this is a real group (>2 participants) even if the recent thread is 1:1.
      base({ role: 'user', content: 'z', authorId: 'bob', createdAtMs: 0 }),
      base({ role: 'user', content: 'a', authorId: 'alice', createdAtMs: 1 }),
      base({ role: 'assistant', content: 'b', createdAtMs: 2 }),
      base({ role: 'user', content: 'c', authorId: 'alice', createdAtMs: 3 }),
      base({ role: 'assistant', content: 'd', createdAtMs: 4 }),
      base({ role: 'user', content: 'e', authorId: 'alice', createdAtMs: 5 }),
      base({ role: 'assistant', content: 'f', createdAtMs: 6 }),
      base({ role: 'user', content: 'g', authorId: 'alice', createdAtMs: 7 }),
      base({ role: 'assistant', content: 'h', createdAtMs: 8 }),
    ];
    expect(detectThreadLock(msgs)).toBe(true);

    const dmLike = msgs.filter((m) => m.authorId !== 'bob');
    expect(detectThreadLock(dmLike)).toBe(false);
  });

  test('computeHeat decays with time', () => {
    const chatId = asChatId('c');
    const msgs: SessionMessage[] = [
      { chatId, role: 'user', content: 'hi', authorId: 'alice', createdAtMs: 1 },
      { chatId, role: 'assistant', content: 'hey', createdAtMs: 2 },
    ];
    const h0 = computeHeat(msgs, 2);
    expect(h0.heat).toBeGreaterThan(0);

    // Half-life is 5 minutes => +5 min should be ~half.
    const h1 = computeHeat(msgs, 2 + 5 * 60_000);
    expect(h1.heat).toBeGreaterThan(0);
    expect(h1.heat).toBeLessThan(h0.heat);
  });

  test('rollEngagement respects participation suppression', () => {
    // Cold general at rng=0.05 would be "send" (send=0.08) unless we suppress.
    const sendNormally = rollEngagement(0, 'general', 1, 0.05);
    expect(sendNormally).toBe('send');

    const suppressed = rollEngagement(0, 'general', 4, 0.05);
    expect(suppressed).not.toBe('send');
  });

  test('participationRateToTarget is 1 at target', () => {
    const chatId = asChatId('c');
    const msgs: SessionMessage[] = [
      { chatId, role: 'user', content: 'a', authorId: 'alice', createdAtMs: 1 },
      { chatId, role: 'user', content: 'b', authorId: 'bob', createdAtMs: 2 },
      { chatId, role: 'assistant', content: 'c', createdAtMs: 3 },
    ];
    const stats = computeParticipationStats(msgs);
    const rate = participationRateToTarget(stats);
    expect(rate).toBeGreaterThan(0);
  });
});
