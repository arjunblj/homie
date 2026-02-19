import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { HomieBehaviorConfig } from '../config/types.js';
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

    const behavior: HomieBehaviorConfig = {
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

    const behavior: HomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const msg = baseMsg({ isGroup: true, authorId: 'alice', timestampMs: 123 });
    const engine = new BehaviorEngine({ behavior, backend, now: () => fixedNow });
    const out = await engine.decidePreDraft(msg, 'hello');
    expect(out.kind).toBe('react');
    if (out.kind !== 'react') throw new Error('Expected react');
    expect(out.emoji).toBe('💀');
    expect(out.reason).toBe('no_substance');
  });

  test('falls back to send on invalid JSON', async () => {
    const backend: LLMBackend = {
      async complete() {
        return { text: 'lol idk', steps: [] };
      },
    };

    const behavior: HomieBehaviorConfig = {
      sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    };

    const engine = new BehaviorEngine({ behavior, backend, now: () => fixedNow });
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true }), 'hello');
    expect(out).toEqual({ kind: 'send' });
  });

  test('random skip can override send for unmentioned group messages', async () => {
    const backend: LLMBackend = {
      async complete() {
        return { text: '{"action":"send","reason":"good_joke"}', steps: [] };
      },
    };

    const behavior: HomieBehaviorConfig = {
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
  });

  test('random skip does not override explicit mentions', async () => {
    const backend: LLMBackend = {
      async complete() {
        return { text: '{"action":"send"}', steps: [] };
      },
    };

    const behavior: HomieBehaviorConfig = {
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
    const out = await engine.decidePreDraft(baseMsg({ isGroup: true, mentioned: true }), 'hello');
    expect(out).toEqual({ kind: 'send' });
  });
});
