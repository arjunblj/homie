import { describe, expect, test } from 'bun:test';
import { scoreFeedback } from './scoring.js';
import { isRefinement } from './tracker.js';

describe('isRefinement', () => {
  test('detects "actually" prefix', () => {
    expect(isRefinement('Actually, I meant the other one')).toBe(true);
    expect(isRefinement('actually no')).toBe(true);
  });
  test('detects "no," prefix', () => {
    expect(isRefinement('No, I said Tuesday')).toBe(true);
    expect(isRefinement('no. that is not right')).toBe(true);
  });
  test('detects "I meant" prefix', () => {
    expect(isRefinement('I meant the blue one')).toBe(true);
    expect(isRefinement('what i meant was...')).toBe(true);
  });
  test('detects "not what I" prefix', () => {
    expect(isRefinement('not what I said')).toBe(true);
  });
  test('ignores normal replies', () => {
    expect(isRefinement('sounds good')).toBe(false);
    expect(isRefinement('yeah totally')).toBe(false);
    expect(isRefinement('no way lol')).toBe(false);
  });
});

describe('feedback scoring', () => {
  test('penalizes no response to question mildly (not enough for failure lesson alone)', () => {
    const out = scoreFeedback({
      isGroup: false,
      timeToFirstResponseMs: undefined,
      responseCount: 0,
      reactionCount: 0,
      negativeReactionCount: 0,
      reactionNetScore: 0,
      outgoingEndsWithQuestion: true,
    });
    expect(out.score).toBeLessThan(0);
    expect(out.score).toBeGreaterThan(-0.3);
    expect(out.reasons).toContain('no_response_to_question');
  });

  test('no response to statement is neutral', () => {
    const out = scoreFeedback({
      isGroup: false,
      timeToFirstResponseMs: undefined,
      responseCount: 0,
      reactionCount: 0,
      negativeReactionCount: 0,
      reactionNetScore: 0,
      outgoingEndsWithQuestion: false,
    });
    expect(out.score).toBe(0);
    expect(out.reasons).toContain('no_response_to_statement');
  });

  test('no response to question + negative reaction crosses failure threshold', () => {
    const out = scoreFeedback({
      isGroup: false,
      timeToFirstResponseMs: undefined,
      responseCount: 0,
      reactionCount: 1,
      negativeReactionCount: 1,
      reactionNetScore: -0.5,
      outgoingEndsWithQuestion: true,
    });
    expect(out.score).toBeLessThan(-0.3);
  });

  test('rewards fast responses and continuation', () => {
    const out = scoreFeedback({
      isGroup: false,
      timeToFirstResponseMs: 15_000,
      responseCount: 2,
      reactionCount: 1,
      negativeReactionCount: 0,
      reactionNetScore: 0.3,
    });
    expect(out.score).toBeGreaterThan(0.6);
  });

  test('penalizes refinement signal', () => {
    const base = scoreFeedback({
      isGroup: false,
      timeToFirstResponseMs: 5_000,
      responseCount: 1,
      reactionCount: 0,
      negativeReactionCount: 0,
      reactionNetScore: 0,
    });
    const withRefinement = scoreFeedback({
      isGroup: false,
      timeToFirstResponseMs: 5_000,
      responseCount: 1,
      reactionCount: 0,
      negativeReactionCount: 0,
      reactionNetScore: 0,
      refinement: true,
    });
    expect(withRefinement.score).toBeLessThan(base.score);
    expect(withRefinement.reasons).toContain('refinement');
  });
});
