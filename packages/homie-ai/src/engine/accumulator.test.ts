import { describe, expect, test } from 'bun:test';
import { asChatId } from '../types/ids.js';
import {
  MessageAccumulator,
  hasContinuationSignal,
  isShortUnterminated,
  shouldFlushImmediately,
} from './accumulator.js';

const chat = asChatId('test:chat1');
const chat2 = asChatId('test:chat2');

describe('isShortUnterminated', () => {
  test('short without punctuation', () => {
    expect(isShortUnterminated('yeah so')).toBe(true);
  });
  test('short with terminal punctuation', () => {
    expect(isShortUnterminated('ok.')).toBe(false);
  });
  test('long message', () => {
    expect(isShortUnterminated('this is a longer message without punct')).toBe(false);
  });
  test('empty string', () => {
    expect(isShortUnterminated('')).toBe(false);
  });
});

describe('hasContinuationSignal', () => {
  test('trailing ellipsis', () => {
    expect(hasContinuationSignal('I was thinking...')).toBe(true);
  });
  test('trailing "and"', () => {
    expect(hasContinuationSignal('I went to the store and')).toBe(true);
  });
  test('trailing "but"', () => {
    expect(hasContinuationSignal('it was fine but')).toBe(true);
  });
  test('trailing "also"', () => {
    expect(hasContinuationSignal('also')).toBe(true);
  });
  test('short unterminated', () => {
    expect(hasContinuationSignal('wait')).toBe(true);
  });
  test('terminated sentence', () => {
    expect(hasContinuationSignal('This is a complete thought.')).toBe(false);
  });
  test('long message, no trailing signal', () => {
    expect(hasContinuationSignal('I already finished everything up')).toBe(false);
  });
});

describe('shouldFlushImmediately', () => {
  test('command prefix', () => {
    expect(shouldFlushImmediately({ text: '/help', isGroup: false })).toBe(true);
    expect(shouldFlushImmediately({ text: '/stop now', isGroup: true })).toBe(true);
  });
  test('@mention in group', () => {
    expect(shouldFlushImmediately({ text: 'hey', isGroup: true, mentioned: true })).toBe(true);
  });
  test('@mention in DM is not special', () => {
    expect(shouldFlushImmediately({ text: 'hey', isGroup: false, mentioned: true })).toBe(false);
  });
  test('normal message', () => {
    expect(shouldFlushImmediately({ text: 'hello there!', isGroup: false })).toBe(false);
    expect(shouldFlushImmediately({ text: 'hello there!', isGroup: true })).toBe(false);
  });
});

describe('MessageAccumulator', () => {
  test('DM base window is 2000ms', () => {
    const acc = new MessageAccumulator();
    expect(acc.getDebounceMs({ chatId: chat, text: 'hello world!', isGroup: false })).toBe(2000);
  });

  test('group base window is 3000ms', () => {
    const acc = new MessageAccumulator();
    expect(acc.getDebounceMs({ chatId: chat, text: 'hello world!', isGroup: true })).toBe(3000);
  });

  test('continuation signal extends by 1.5x', () => {
    const acc = new MessageAccumulator();
    expect(
      acc.getDebounceMs({ chatId: chat, text: 'I was thinking...', isGroup: true }),
    ).toBe(4500);
  });

  test('continuation in DM extends to 3000ms', () => {
    const acc = new MessageAccumulator();
    expect(
      acc.getDebounceMs({ chatId: chat, text: 'wait', isGroup: false }),
    ).toBe(3000);
  });

  test('hard cap: flushes after maxWaitMs', () => {
    const acc = new MessageAccumulator();
    const t0 = 1_000_000;
    acc.getDebounceMs({ chatId: chat, text: 'msg1!', isGroup: true, nowMs: t0 });
    const ms = acc.getDebounceMs({ chatId: chat, text: 'msg2!', isGroup: true, nowMs: t0 + 10_000 });
    expect(ms).toBe(0);
  });

  test('hard cap: remaining time is bounded', () => {
    const acc = new MessageAccumulator();
    const t0 = 1_000_000;
    acc.getDebounceMs({ chatId: chat, text: 'msg1!', isGroup: true, nowMs: t0 });
    const ms = acc.getDebounceMs({ chatId: chat, text: 'msg2!', isGroup: true, nowMs: t0 + 8000 });
    expect(ms).toBe(2000);
  });

  test('message count cap: flushes at 20 messages', () => {
    const acc = new MessageAccumulator();
    const t0 = 1_000_000;
    for (let i = 0; i < 19; i++) {
      acc.getDebounceMs({ chatId: chat, text: `msg${i}!`, isGroup: true, nowMs: t0 + i * 100 });
    }
    const ms = acc.getDebounceMs({ chatId: chat, text: 'msg20!', isGroup: true, nowMs: t0 + 1900 });
    expect(ms).toBe(0);
  });

  test('command flushes immediately and clears batch', () => {
    const acc = new MessageAccumulator();
    acc.getDebounceMs({ chatId: chat, text: 'first msg!', isGroup: true });
    expect(acc.getDebounceMs({ chatId: chat, text: '/help', isGroup: true })).toBe(0);
    // Next message starts a fresh batch
    expect(acc.getDebounceMs({ chatId: chat, text: 'new msg!', isGroup: true })).toBe(3000);
  });

  test('@mention in group flushes immediately', () => {
    const acc = new MessageAccumulator();
    acc.getDebounceMs({ chatId: chat, text: 'first msg!', isGroup: true });
    const ms = acc.getDebounceMs({
      chatId: chat,
      text: 'hey bot, what do you think?',
      isGroup: true,
      mentioned: true,
    });
    expect(ms).toBe(0);
  });

  test('separate chats have independent state', () => {
    const acc = new MessageAccumulator();
    const t0 = 1_000_000;
    acc.getDebounceMs({ chatId: chat, text: 'msg a!', isGroup: true, nowMs: t0 });
    acc.getDebounceMs({ chatId: chat2, text: 'msg b!', isGroup: true, nowMs: t0 });
    // Second message in chat1 increments its count; chat2 is still at 1
    const ms1 = acc.getDebounceMs({ chatId: chat, text: 'msg a2!', isGroup: true, nowMs: t0 + 500 });
    const ms2 = acc.getDebounceMs({ chatId: chat2, text: 'msg b2!', isGroup: true, nowMs: t0 + 500 });
    expect(ms1).toBe(3000);
    expect(ms2).toBe(3000);
  });

  test('clear resets batch state', () => {
    const acc = new MessageAccumulator();
    const t0 = 1_000_000;
    acc.getDebounceMs({ chatId: chat, text: 'msg1!', isGroup: true, nowMs: t0 });
    acc.clear(chat);
    const ms = acc.getDebounceMs({ chatId: chat, text: 'msg2!', isGroup: true, nowMs: t0 + 5000 });
    expect(ms).toBe(3000);
  });
});
