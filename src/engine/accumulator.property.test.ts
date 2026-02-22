import { describe, expect } from 'bun:test';
import fc from 'fast-check';

import type { IncomingMessage } from '../agent/types.js';
import { fcPropertyTest } from '../testing/fc.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { MessageAccumulator } from './accumulator.js';

describe('engine/accumulator (property)', () => {
  const baseMsg = (i: number, overrides: Partial<IncomingMessage>): IncomingMessage => ({
    channel: 'cli',
    chatId: asChatId('cli:local'),
    messageId: asMessageId(`m:${i}`),
    authorId: 'u',
    text: 'hi',
    isGroup: false,
    isOperator: true,
    timestampMs: 0,
    ...overrides,
  });

  fcPropertyTest(
    'pushAndGetDebounceMs returns a bounded, non-negative value',
    fc.array(
      fc.record({
        text: fc.string({ maxLength: 80 }),
        isGroup: fc.boolean(),
        mentioned: fc.option(fc.boolean(), { nil: undefined }),
        hasAttachments: fc.boolean(),
        deltaMs: fc.integer({ min: 0, max: 5000 }),
      }),
      { minLength: 1, maxLength: 200 },
    ),
    (steps) => {
      const acc = new MessageAccumulator();
      let nowMs = 1_000_000;
      let i = 0;

      for (const s of steps) {
        nowMs += s.deltaMs;
        i += 1;
        const msg = baseMsg(i, {
          text: s.text,
          isGroup: s.isGroup,
          ...(typeof s.mentioned === 'boolean' ? { mentioned: s.mentioned } : {}),
          ...(s.hasAttachments ? { attachments: [{ id: 'a', kind: 'image' }] } : {}),
          timestampMs: nowMs,
        });

        const ms = acc.pushAndGetDebounceMs({ msg, nowMs });
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(10_000);

        if (msg.text.trim().startsWith('/')) expect(ms).toBe(0);
        if (s.hasAttachments) expect(ms).toBe(0);
        if (msg.isGroup && msg.mentioned === true) expect(ms).toBe(0);
      }
    },
  );

  fcPropertyTest(
    'drain returns per-chat messages in arrival order',
    fc.array(
      fc.record({
        chat: fc.constantFrom(0, 1),
        text: fc.stringMatching(/^[^/].{0,40}$/u),
        deltaMs: fc.integer({ min: 0, max: 500 }),
      }),
      { minLength: 1, maxLength: 50 },
    ),
    (steps) => {
      const acc = new MessageAccumulator();
      const chatA = asChatId('cli:a');
      const chatB = asChatId('cli:b');
      const expectedA: string[] = [];
      const expectedB: string[] = [];

      let nowMs = 1_000_000;
      let i = 0;
      for (const s of steps) {
        nowMs += s.deltaMs;
        i += 1;
        const chatId = s.chat === 0 ? chatA : chatB;
        const m = baseMsg(i, { chatId, text: s.text, timestampMs: nowMs });
        acc.pushAndGetDebounceMs({ msg: m, nowMs });
        if (chatId === chatA) expectedA.push(s.text);
        else expectedB.push(s.text);
      }

      const drainedA = acc.drain(chatA).map((m) => m.text);
      const drainedB = acc.drain(chatB).map((m) => m.text);
      expect(drainedA).toEqual(expectedA);
      expect(drainedB).toEqual(expectedB);
    },
  );
});
