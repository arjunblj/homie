import { describe, expect, test } from 'bun:test';

import { IdentitySchema, interviewQuestionSchema } from './schemas.js';

const LONG_TEXT = 'x'.repeat(60);

describe('IdentitySchema', () => {
  test('accepts and strips unknown top-level keys from LLM output', () => {
    const parsed = IdentitySchema.safeParse({
      soulMd: LONG_TEXT,
      styleMd: LONG_TEXT,
      userMd: 'y'.repeat(24),
      firstMeetingMd: 'z'.repeat(24),
      personality: {
        traits: ['curious', 'direct', 'kind'],
        voiceRules: ['be concise', 'be honest', 'stay concrete'],
      },
      extra: 'nope',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('interviewQuestionSchema', () => {
  test('requires question when done is false', () => {
    const parsed = interviewQuestionSchema.safeParse({ done: false, question: '' });
    expect(parsed.success).toBe(false);
  });

  test('allows empty question when done is true', () => {
    const parsed = interviewQuestionSchema.safeParse({ done: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.question).toBe('');
    }
  });
});
