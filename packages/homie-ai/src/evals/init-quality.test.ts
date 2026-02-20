import { describe, expect, test } from 'bun:test';

import {
  buildJudgePrompt,
  INIT_QUALITY_CASES,
  JUDGE_SYSTEM_PROMPT,
  TEST_PERSONA,
} from './init-quality.js';

describe('init-quality eval cases', () => {
  test('test persona has all required fields', () => {
    expect(TEST_PERSONA.friendName).toBeTruthy();
    expect(TEST_PERSONA.coreRole).toBeTruthy();
    expect(TEST_PERSONA.vibe).toBeTruthy();
    expect(TEST_PERSONA.neverSays).toBeTruthy();
    expect(TEST_PERSONA.humorStyle).toBeTruthy();
    expect(TEST_PERSONA.textingStyle).toBeTruthy();
    expect(TEST_PERSONA.hardBoundary).toBeTruthy();
  });

  test('all cases have unique ids', () => {
    const ids = INIT_QUALITY_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all cases have rubric focus', () => {
    for (const c of INIT_QUALITY_CASES) {
      expect(c.rubricFocus.length).toBeGreaterThan(10);
    }
  });

  test('judge system prompt includes scoring rubric', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('1-5');
    expect(JUDGE_SYSTEM_PROMPT).toContain('score');
    expect(JUDGE_SYSTEM_PROMPT).toContain('reasoning');
  });

  test('buildJudgePrompt includes all sections', () => {
    const prompt = buildJudgePrompt({
      persona: TEST_PERSONA,
      userText: 'hey',
      response: 'yo whats good',
      rubricFocus: 'Voice consistency',
    });

    expect(prompt).toContain('<identity>');
    expect(prompt).toContain(TEST_PERSONA.friendName);
    expect(prompt).toContain('<user_message>');
    expect(prompt).toContain('hey');
    expect(prompt).toContain('<friend_response>');
    expect(prompt).toContain('yo whats good');
    expect(prompt).toContain('<rubric_focus>');
    expect(prompt).toContain('Voice consistency');
  });

  test('cases cover both dm and group scopes', () => {
    const scopes = new Set(INIT_QUALITY_CASES.map((c) => c.scope));
    expect(scopes.has('dm')).toBe(true);
    expect(scopes.has('group')).toBe(true);
  });
});
