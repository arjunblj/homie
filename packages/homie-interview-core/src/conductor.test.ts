import { describe, expect, test } from 'bun:test';
import { generateIdentity, nextInterviewQuestion, refineIdentity } from './conductor.js';
import type { InterviewModelClient } from './contracts.js';

describe('conductor', () => {
  test('nextInterviewQuestion parses correctly', async () => {
    const mockClient: InterviewModelClient = {
      complete: async () => '{"done": false, "question": "how are you?"}',
    };
    const res = await nextInterviewQuestion(mockClient, {
      friendName: 'Bob',
      questionsAsked: 1,
      transcript: '',
    });
    expect(res).toEqual({ done: false, question: 'how are you?' });
  });

  test('nextInterviewQuestion retries on invalid JSON then succeeds', async () => {
    let calls = 0;
    const mockClient: InterviewModelClient = {
      complete: async () => {
        calls += 1;
        if (calls === 1) return 'not valid json at all';
        return '{"done": false, "question": "retry worked"}';
      },
    };
    const res = await nextInterviewQuestion(mockClient, {
      friendName: 'Bob',
      questionsAsked: 1,
      transcript: '',
    });
    expect(calls).toBe(2);
    expect(res).toEqual({ done: false, question: 'retry worked' });
  });

  test('nextInterviewQuestion throws after exhausting retries', async () => {
    const mockClient: InterviewModelClient = {
      complete: async () => 'garbage',
    };
    await expect(
      nextInterviewQuestion(mockClient, {
        friendName: 'Bob',
        questionsAsked: 1,
        transcript: '',
      }),
    ).rejects.toThrow();
  });

  test('generateIdentity parses correctly', async () => {
    const mockClient: InterviewModelClient = {
      complete: async () =>
        JSON.stringify({
          soulMd: 'SOUL'.repeat(15),
          styleMd: 'STYLE'.repeat(15),
          userMd: 'USER'.repeat(10),
          firstMeetingMd: 'MEETING'.repeat(10),
          personality: {
            traits: ['a', 'b', 'c'],
            voiceRules: ['a', 'b', 'c'],
            antiPatterns: [],
          },
        }),
    };
    const res = await generateIdentity(mockClient, {
      friendName: 'Bob',
      timezone: 'UTC',
      transcript: '',
    });
    expect(res.personality.traits).toEqual(['a', 'b', 'c']);
  });

  test('refineIdentity parses correctly', async () => {
    const mockClient: InterviewModelClient = {
      complete: async () =>
        JSON.stringify({
          soulMd: 'SOUL2'.repeat(15),
          styleMd: 'STYLE'.repeat(15),
          userMd: 'USER'.repeat(10),
          firstMeetingMd: 'MEETING'.repeat(10),
          personality: {
            traits: ['a', 'b', 'c'],
            voiceRules: ['a', 'b', 'c'],
            antiPatterns: [],
          },
        }),
    };
    const current = {
      soulMd: 'SOUL'.repeat(15),
      styleMd: 'STYLE'.repeat(15),
      userMd: 'USER'.repeat(10),
      firstMeetingMd: 'MEETING'.repeat(10),
      personality: { traits: ['a', 'b', 'c'], voiceRules: ['a', 'b', 'c'], antiPatterns: [] },
    };
    const res = await refineIdentity(mockClient, {
      feedback: 'change soul',
      currentIdentity: current,
    });
    expect(res.soulMd).toContain('SOUL2');
  });
});
