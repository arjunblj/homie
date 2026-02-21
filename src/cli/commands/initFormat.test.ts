import { describe, expect, test } from 'bun:test';
import type { IdentityDraft } from '../../interview/schemas.js';
import { formatDetectionLine, formatIdentityPreview } from './initFormat.js';

describe('formatDetectionLine', () => {
  test('returns checkmark text when ok is true', () => {
    const result = formatDetectionLine('Claude Code CLI', true, 'detected');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Claude Code CLI');
  });

  test('returns dim text when ok is false', () => {
    const result = formatDetectionLine('Ollama', false, 'not found');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Ollama');
  });
});

describe('formatIdentityPreview', () => {
  const draft: IdentityDraft = {
    soulMd: 'A helpful assistant that values clarity.\nBuilt for developers.\nAlways kind.',
    styleMd: 'Use concise sentences. Avoid jargon where possible.',
    userMd: 'The user is a developer working on CLI tools.',
    firstMeetingMd: 'Hello! I am homie, your friendly AI companion.',
    personality: {
      traits: ['curious', 'empathetic', 'concise'],
      voiceRules: ['use lowercase', 'no emojis', 'short sentences'],
      antiPatterns: ['never be condescending'],
    },
  };

  test('returns non-empty string containing soul/style/user content', () => {
    const result = formatIdentityPreview(draft, 'homie');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Personality traits');
    expect(result).toContain('Voice & style');
    expect(result).toContain('Soul');
  });
});
