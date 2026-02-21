import { describe, expect, test } from 'bun:test';

import { EMPTY_USAGE } from './format.js';
import { accumulateLlmCalls } from './useSessionUsage.js';

describe('accumulateLlmCalls', () => {
  test('adds increment to current count', () => {
    expect(accumulateLlmCalls(3, 2)).toBe(5);
  });

  test('supports zero increment', () => {
    expect(accumulateLlmCalls(7, 0)).toBe(7);
  });

  test('can reset back to zero through helper semantics', () => {
    expect(EMPTY_USAGE).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });
});
