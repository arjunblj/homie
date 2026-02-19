import { describe, expect, test } from 'bun:test';

import { decideFromVelocity, looksLikeContinuation, type VelocitySnapshot } from './velocity.js';

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
});
