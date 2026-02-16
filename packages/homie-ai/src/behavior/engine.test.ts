import { describe, expect, test } from 'bun:test';

import type { LLMBackend } from '../backend/types.js';
import type { HomieBehaviorConfig } from '../config/types.js';
import type { IncomingMessage } from '../agent/types.js';
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
    const backend: LLMBackend = {
      async complete() {
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
    const out = await engine.decide(baseMsg({ isOperator: false }), 'draft');
    expect(out.kind).toBe('silence');
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
    const out = await engine.decide(msg, 'draft');
    expect(out.kind).toBe('react');
    if (out.kind !== 'react') throw new Error('Expected react');
    expect(out.emoji).toBe('💀');
    expect(out.targetAuthorId).toBe('alice');
    expect(out.targetTimestampMs).toBe(123);
  });

  test('falls back to send_text on invalid JSON', async () => {
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
    const out = await engine.decide(baseMsg({ isGroup: true }), 'draft');
    expect(out).toEqual({ kind: 'send_text', text: 'draft' });
  });
});

