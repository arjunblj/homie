import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { OpenhomieBehaviorConfig } from '../config/types.js';
import type { SessionStore } from '../session/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { BehaviorEngine } from './engine.js';

const baseMsg = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channel: 'signal',
  chatId: asChatId('c'),
  messageId: asMessageId('m'),
  authorId: 'u',
  text: 'hello',
  isGroup: true,
  isOperator: false,
  timestampMs: 1700000000000,
  ...overrides,
});

const fixedNow = new Date('2026-02-16T12:00:00.000Z');

describe('BehaviorEngine', () => {
  test('silences during sleep mode for non-operator', async () => {
    let calls = 0;
    const backend: LLMBackend = {
      async complete() {
        calls += 1;
        return { text: '{"action":"send"}', steps: [] };
      },
    };

    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: true, timezone: 'UTC', startLocal: '00:00', endLocal: '23:59' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const engine = new BehaviorEngine({ behavior, backend, now: () => fixedNow });
    const out = await engine.decidePreDraft(baseMsg({ isOperator: false }), 'hello');
    expect(out).toEqual({ kind: 'silence', reason: 'sleep_mode' });
    expect(calls).toBe(0);
  });

  test('returns reaction when fast model says react', async () => {
    const backend: LLMBackend = {
      async complete() {
        return { text: '{"action":"react","emoji":"💀","reason":"no_substance"}', steps: [] };
      },
    };

    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const msg = baseMsg({ isGroup: true, authorId: 'alice', timestampMs: 123, mentioned: true });
    const engine = new BehaviorEngine({ behavior, backend, now: () => fixedNow });
    const out = await engine.decidePreDraft(msg, 'hello');
    expect(out.kind).toBe('react');
    if (out.kind !== 'react') throw new Error('Expected react');
    expect(out.emoji).toBe('💀');
    expect(out.reason).toBe('no_substance');
  });

  test('does not call the LLM gate for unmentioned group messages', async () => {
    let calls = 0;
    const backend: LLMBackend = {
      async complete() {
        calls += 1;
        return { text: '{"action":"send"}', steps: [] };
      },
    };

    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const engine = new BehaviorEngine({
      behavior,
      backend,
      now: () => fixedNow,
      randomSkipRate: 0,
      rng: () => 0.99,
    });
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true, mentioned: false }), 'hello');
    expect(out).toEqual({ kind: 'silence', reason: 'engagement_silence' });
    expect(calls).toBe(0);
  });

  test('falls back to send on invalid JSON when explicitly mentioned', async () => {
    const backend: LLMBackend = {
      async complete() {
        return { text: 'lol idk', steps: [] };
      },
    };

    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const engine = new BehaviorEngine({ behavior, backend, now: () => fixedNow });
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true, mentioned: true }), 'hello');
    expect(out).toEqual({ kind: 'send' });
  });

  test('random skip can override send for unmentioned group messages', async () => {
    let calls = 0;
    const backend: LLMBackend = {
      async complete() {
        calls += 1;
        return { text: '{"action":"send","reason":"good_joke"}', steps: [] };
      },
    };

    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const engine = new BehaviorEngine({
      behavior,
      backend,
      now: () => fixedNow,
      randomSkipRate: 1,
      rng: () => 0,
    });
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true, mentioned: false }), 'hello');
    expect(out).toEqual({ kind: 'silence', reason: 'random_skip' });
    expect(calls).toBe(0);
  });

  test('random skip does not override explicit mentions', async () => {
    const backend: LLMBackend = {
      async complete() {
        return { text: '{"action":"send"}', steps: [] };
      },
    };

    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const engine = new BehaviorEngine({
      behavior,
      backend,
      now: () => fixedNow,
      randomSkipRate: 1,
      rng: () => 0,
    });
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true, mentioned: true }), 'hello?');
    expect(out).toEqual({ kind: 'send' });
  });

  test('domination check silences when agent share exceeds threshold', async () => {
    let backendCalled = false;
    const backend: LLMBackend = {
      async complete() {
        backendCalled = true;
        return { text: '{"action":"send"}', steps: [] };
      },
    };

    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    // 8 messages total, 4 are assistant (50% share) with 2 distinct users => 3-person group
    // threshold for <=4 is 0.3, so 50% > 30% => should silence
    const mockMessages = [
      {
        role: 'user' as const,
        content: 'hi',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 1,
      },
      { role: 'assistant' as const, content: 'hey', chatId: asChatId('c'), createdAtMs: 2 },
      {
        role: 'user' as const,
        content: 'yo',
        authorId: 'bob',
        chatId: asChatId('c'),
        createdAtMs: 3,
      },
      { role: 'assistant' as const, content: 'sup', chatId: asChatId('c'), createdAtMs: 4 },
      {
        role: 'user' as const,
        content: 'lol',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 5,
      },
      { role: 'assistant' as const, content: 'haha', chatId: asChatId('c'), createdAtMs: 6 },
      {
        role: 'user' as const,
        content: 'right',
        authorId: 'bob',
        chatId: asChatId('c'),
        createdAtMs: 7,
      },
      { role: 'assistant' as const, content: 'yeah', chatId: asChatId('c'), createdAtMs: 8 },
    ];
    const sessionStore = { getMessages: () => mockMessages } as unknown as SessionStore;

    const engine = new BehaviorEngine({ behavior, backend, now: () => fixedNow });
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true }), 'hello', { sessionStore });
    expect(out).toEqual({ kind: 'silence', reason: 'domination_check' });
    expect(backendCalled).toBe(false);
  });

  test('domination check allows send when agent share is below threshold', async () => {
    const backend: LLMBackend = {
      async complete() {
        return { text: '{"action":"send"}', steps: [] };
      },
    };

    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    // 8 messages total, 1 is assistant (12.5% share) with 3 distinct users => 4-person group
    // threshold for <=4 is 0.3, so 12.5% < 30% => should proceed to LLM gate
    const mockMessages = [
      {
        role: 'user' as const,
        content: 'hi',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 1,
      },
      {
        role: 'user' as const,
        content: 'yo',
        authorId: 'bob',
        chatId: asChatId('c'),
        createdAtMs: 2,
      },
      {
        role: 'user' as const,
        content: 'sup',
        authorId: 'charlie',
        chatId: asChatId('c'),
        createdAtMs: 3,
      },
      { role: 'assistant' as const, content: 'hey all', chatId: asChatId('c'), createdAtMs: 4 },
      {
        role: 'user' as const,
        content: 'lol',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 5,
      },
      {
        role: 'user' as const,
        content: 'nice',
        authorId: 'bob',
        chatId: asChatId('c'),
        createdAtMs: 6,
      },
      {
        role: 'user' as const,
        content: 'haha',
        authorId: 'charlie',
        chatId: asChatId('c'),
        createdAtMs: 7,
      },
      {
        role: 'user' as const,
        content: 'yeah',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 8,
      },
    ];
    const sessionStore = { getMessages: () => mockMessages } as unknown as SessionStore;

    const engine = new BehaviorEngine({
      behavior,
      backend,
      now: () => fixedNow,
      randomSkipRate: 0,
      rng: () => 0,
    });
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true }), 'hello', { sessionStore });
    expect(out).toEqual({ kind: 'send' });
  });

  test('thread lock forces silence', async () => {
    let backendCalled = false;
    const backend: LLMBackend = {
      async complete() {
        backendCalled = true;
        return { text: '{"action":"send"}', steps: [] };
      },
    };
    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const mockMessages = [
      // Evidence this is a real group (>2 participants) even though the latest thread is 1:1.
      {
        role: 'user' as const,
        content: 'z',
        authorId: 'bob',
        chatId: asChatId('c'),
        createdAtMs: 0,
      },
      {
        role: 'user' as const,
        content: 'a',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 1,
      },
      {
        role: 'assistant' as const,
        content: '[REACTION] 💀',
        chatId: asChatId('c'),
        createdAtMs: 2,
      },
      {
        role: 'user' as const,
        content: 'c',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 3,
      },
      {
        role: 'assistant' as const,
        content: '[REACTION] 💀',
        chatId: asChatId('c'),
        createdAtMs: 4,
      },
      {
        role: 'user' as const,
        content: 'e',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 5,
      },
      {
        role: 'assistant' as const,
        content: '[REACTION] 💀',
        chatId: asChatId('c'),
        createdAtMs: 6,
      },
      {
        role: 'user' as const,
        content: 'g',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 7,
      },
      {
        role: 'assistant' as const,
        content: '[REACTION] 💀',
        chatId: asChatId('c'),
        createdAtMs: 8,
      },
    ];
    const sessionStore = { getMessages: () => mockMessages } as unknown as SessionStore;

    const engine = new BehaviorEngine({ behavior, backend, now: () => fixedNow });
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true }), 'hello', { sessionStore });
    expect(out).toEqual({ kind: 'silence', reason: 'thread_lock' });
    expect(backendCalled).toBe(false);
  });

  test('thread lock does not override direct mention questions', async () => {
    let backendCalled = false;
    const backend: LLMBackend = {
      async complete() {
        backendCalled = true;
        return { text: '{"action":"send"}', steps: [] };
      },
    };
    const behavior: OpenhomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const mockMessages = [
      // Evidence this is a real group (>2 participants) even though the latest thread is 1:1.
      {
        role: 'user' as const,
        content: 'z',
        authorId: 'bob',
        chatId: asChatId('c'),
        createdAtMs: 0,
      },
      {
        role: 'user' as const,
        content: 'a',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 1,
      },
      {
        role: 'assistant' as const,
        content: '[REACTION] 💀',
        chatId: asChatId('c'),
        createdAtMs: 2,
      },
      {
        role: 'user' as const,
        content: 'c',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 3,
      },
      {
        role: 'assistant' as const,
        content: '[REACTION] 💀',
        chatId: asChatId('c'),
        createdAtMs: 4,
      },
      {
        role: 'user' as const,
        content: 'e',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 5,
      },
      {
        role: 'assistant' as const,
        content: '[REACTION] 💀',
        chatId: asChatId('c'),
        createdAtMs: 6,
      },
      {
        role: 'user' as const,
        content: 'g',
        authorId: 'alice',
        chatId: asChatId('c'),
        createdAtMs: 7,
      },
      {
        role: 'assistant' as const,
        content: '[REACTION] 💀',
        chatId: asChatId('c'),
        createdAtMs: 8,
      },
    ];
    const sessionStore = { getMessages: () => mockMessages } as unknown as SessionStore;

    const engine = new BehaviorEngine({ behavior, backend, now: () => fixedNow });
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true, mentioned: true }), 'yo?', {
      sessionStore,
    });
    expect(out).toEqual({ kind: 'send' });
    expect(backendCalled).toBe(false);
  });
});
