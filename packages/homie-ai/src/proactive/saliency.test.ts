import { describe, expect, test } from 'bun:test';
import type { MemoryStore } from '../memory/store.js';
import { asPersonId } from '../types/ids.js';
import { findSalientSubject, SALIENCY_THRESHOLD, scoreSaliency } from './saliency.js';

describe('saliency', () => {
  describe('scoreSaliency', () => {
    test('returns weighted sum of recency, emotional, unresolved', () => {
      expect(scoreSaliency({ content: 'x', recency: 1, emotional: 1, unresolved: 1 })).toBe(1);
      expect(scoreSaliency({ content: 'x', recency: 0, emotional: 0, unresolved: 0 })).toBe(0);
      expect(
        scoreSaliency({ content: 'x', recency: 1, emotional: 0.5, unresolved: 0.5 }),
      ).toBeCloseTo(0.35 + 0.175 + 0.15);
    });

    test('high concern scores above threshold', () => {
      const score = scoreSaliency({
        content: 'job stress',
        recency: 1,
        emotional: 1,
        unresolved: 1,
      });
      expect(score).toBe(1);
      expect(score).toBeGreaterThanOrEqual(SALIENCY_THRESHOLD);
    });

    test('low scores stay below threshold', () => {
      const score = scoreSaliency({
        content: 'old fact',
        recency: 0.1,
        emotional: 0.3,
        unresolved: 0.1,
      });
      expect(score).toBeLessThan(SALIENCY_THRESHOLD);
    });
  });

  describe('findSalientSubject', () => {
    test('returns null when store has no data', async () => {
      const store = {
        getStructuredPersonData: async () => ({
          currentConcerns: [],
          goals: [],
          preferences: {},
          lastMoodSignal: null,
          curiosityQuestions: [],
        }),
        getFactsForPerson: async () => [],
      } as unknown as MemoryStore;

      const result = await findSalientSubject({ store, personId: asPersonId('p1') });
      expect(result).toBeNull();
    });

    test('returns highest-scoring concern when present', async () => {
      const store = {
        getStructuredPersonData: async () => ({
          currentConcerns: ['job interview anxiety'],
          goals: [],
          preferences: {},
          lastMoodSignal: 'stressed',
          curiosityQuestions: [],
        }),
        getFactsForPerson: async () => [],
      } as unknown as MemoryStore;

      const result = await findSalientSubject({ store, personId: asPersonId('p1') });
      expect(result).not.toBeNull();
      expect(result?.subject).toBe('job interview anxiety');
      expect(result?.score).toBe(1);
    });

    test('returns goal when no concerns', async () => {
      const store = {
        getStructuredPersonData: async () => ({
          currentConcerns: [],
          goals: ['run a marathon'],
          preferences: {},
          lastMoodSignal: null,
          curiosityQuestions: [],
        }),
        getFactsForPerson: async () => [],
      } as unknown as MemoryStore;

      const result = await findSalientSubject({ store, personId: asPersonId('p1') });
      expect(result).not.toBeNull();
      expect(result?.subject).toBe('run a marathon');
      expect(result?.score).toBeGreaterThanOrEqual(SALIENCY_THRESHOLD);
    });

    test('prefers concern over goal when both present', async () => {
      const store = {
        getStructuredPersonData: async () => ({
          currentConcerns: ['health scare'],
          goals: ['learn guitar'],
          preferences: {},
          lastMoodSignal: 'worried',
          curiosityQuestions: [],
        }),
        getFactsForPerson: async () => [],
      } as unknown as MemoryStore;

      const result = await findSalientSubject({ store, personId: asPersonId('p1') });
      expect(result).not.toBeNull();
      expect(result?.subject).toBe('health scare');
    });

    test('returns recent fact when no concerns or goals', async () => {
      const nowMs = Date.now();
      const recentFactCreated = nowMs - 24 * 60 * 60_000; // 1 day ago

      const store = {
        getStructuredPersonData: async () => ({
          currentConcerns: [],
          goals: [],
          preferences: {},
          lastMoodSignal: null,
          curiosityQuestions: [],
        }),
        getFactsForPerson: async () => [
          {
            content: 'Planning a trip to Japan',
            createdAtMs: recentFactCreated,
          },
        ],
      } as unknown as MemoryStore;

      const result = await findSalientSubject({
        store,
        personId: asPersonId('p1'),
        nowMs,
      });
      expect(result).not.toBeNull();
      expect(result?.subject).toBe('Planning a trip to Japan');
    });
  });
});
