import { describe, expect, test } from 'bun:test';

import { getAnthropicThinking } from './thinking.js';

describe('getAnthropicThinking', () => {
  test('returns null for fast role', () => {
    expect(getAnthropicThinking('claude-opus-4-6', 'fast')).toBeNull();
  });

  test('enables adaptive thinking for opus', () => {
    expect(getAnthropicThinking('claude-opus-4-6', 'default')).toEqual({ type: 'adaptive' });
  });

  test('enables fixed budget thinking for sonnet', () => {
    expect(getAnthropicThinking('claude-sonnet-4-5', 'default')).toEqual({
      type: 'enabled',
      budgetTokens: 1024,
    });
  });

  test('returns null for other models', () => {
    expect(getAnthropicThinking('claude-haiku-4-5', 'default')).toBeNull();
  });
});

