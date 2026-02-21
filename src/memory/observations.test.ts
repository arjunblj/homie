import { describe, expect, test } from 'bun:test';
import { EMPTY_COUNTERS, updateCounters } from './observations.js';

describe('observations', () => {
  test('updateCounters with a single observation', () => {
    const result = updateCounters(EMPTY_COUNTERS, {
      responseLength: 100,
      theirMessageLength: 50,
      hourOfDay: 14,
      isNewConversation: true,
    });

    expect(result.avgResponseLength).toBe(100);
    expect(result.avgTheirMessageLength).toBe(50);
    expect(result.activeHoursBitmask).toBe(1 << 14);
    expect(result.conversationCount).toBe(1);
    expect(result.sampleCount).toBe(1);
  });

  test('incremental average convergence', () => {
    let current = EMPTY_COUNTERS;

    current = updateCounters(current, {
      responseLength: 100,
      theirMessageLength: 50,
      hourOfDay: 0,
      isNewConversation: true,
    });
    expect(current.avgResponseLength).toBe(100);
    expect(current.sampleCount).toBe(1);

    current = updateCounters(current, {
      responseLength: 200,
      theirMessageLength: 100,
      hourOfDay: 1,
      isNewConversation: false,
    });
    expect(current.avgResponseLength).toBe(150);
    expect(current.avgTheirMessageLength).toBe(75);
    expect(current.sampleCount).toBe(2);

    current = updateCounters(current, {
      responseLength: 150,
      theirMessageLength: 75,
      hourOfDay: 2,
      isNewConversation: false,
    });
    expect(current.avgResponseLength).toBe(150);
    expect(current.avgTheirMessageLength).toBe(75);
    expect(current.sampleCount).toBe(3);
  });

  test('active hours bitmask accumulation', () => {
    let current = EMPTY_COUNTERS;

    current = updateCounters(current, {
      responseLength: 0,
      theirMessageLength: 0,
      hourOfDay: 0,
      isNewConversation: false,
    });
    expect(current.activeHoursBitmask).toBe(1);

    current = updateCounters(current, {
      responseLength: 0,
      theirMessageLength: 0,
      hourOfDay: 12,
      isNewConversation: false,
    });
    expect(current.activeHoursBitmask).toBe((1 << 0) | (1 << 12));

    current = updateCounters(current, {
      responseLength: 0,
      theirMessageLength: 0,
      hourOfDay: 0,
      isNewConversation: false,
    });
    expect(current.activeHoursBitmask).toBe((1 << 0) | (1 << 12));
  });

  test('conversation count increments only when isNewConversation', () => {
    let current = EMPTY_COUNTERS;

    current = updateCounters(current, {
      responseLength: 0,
      theirMessageLength: 0,
      hourOfDay: 0,
      isNewConversation: true,
    });
    expect(current.conversationCount).toBe(1);

    current = updateCounters(current, {
      responseLength: 0,
      theirMessageLength: 0,
      hourOfDay: 0,
      isNewConversation: false,
    });
    expect(current.conversationCount).toBe(1);

    current = updateCounters(current, {
      responseLength: 0,
      theirMessageLength: 0,
      hourOfDay: 0,
      isNewConversation: true,
    });
    expect(current.conversationCount).toBe(2);
  });
});
