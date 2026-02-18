import { describe, expect, test } from 'bun:test';
import { scoreFeedback } from './scoring.js';

describe('feedback scoring', () => {
  test('penalizes no response mildly (not enough for failure lesson alone)', () => {
    const out = scoreFeedback({
      isGroup: false,
      timeToFirstResponseMs: undefined,
      responseCount: 0,
      reactionCount: 0,
      negativeReactionCount: 0,
      reactionNetScore: 0,
    });
    expect(out.score).toBeLessThan(0);
    expect(out.score).toBeGreaterThan(-0.3);
  });

  test('no response + negative reaction crosses failure threshold', () => {
    const out = scoreFeedback({
      isGroup: false,
      timeToFirstResponseMs: undefined,
      responseCount: 0,
      reactionCount: 1,
      negativeReactionCount: 1,
      reactionNetScore: -0.5,
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
});
