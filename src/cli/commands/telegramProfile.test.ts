import { describe, expect, test } from 'bun:test';
import type { IdentityDraft } from '../../interview/schemas.js';
import {
  extractTelegramBotDescription,
  extractTelegramBotShortDescription,
  suggestTelegramBotUsername,
} from './telegramProfile.js';

const makeDraft = (partial: Partial<IdentityDraft>): IdentityDraft => {
  return {
    soulMd: partial.soulMd ?? 'x'.repeat(60),
    styleMd: partial.styleMd ?? 'x'.repeat(60),
    userMd: partial.userMd ?? 'x'.repeat(30),
    firstMeetingMd: partial.firstMeetingMd ?? 'x'.repeat(30),
    personality: partial.personality ?? {
      traits: ['curious', 'direct', 'kind'],
      voiceRules: ['be concise', 'ask clarifying questions', 'avoid fluff'],
      antiPatterns: [],
    },
  };
};

describe('suggestTelegramBotUsername', () => {
  test('returns a bot username suggestion that ends with _bot', () => {
    const u = suggestTelegramBotUsername('Homie');
    expect(u.endsWith('_bot')).toBeTrue();
    expect(u.length).toBeGreaterThanOrEqual(5);
    expect(u.length).toBeLessThanOrEqual(32);
    expect(/^[a-z0-9_]+$/u.test(u)).toBeTrue();
  });

  test('normalizes punctuation and whitespace', () => {
    const u = suggestTelegramBotUsername('Hello,   World!!');
    expect(u).toContain('hello_world');
    expect(u.endsWith('_bot')).toBeTrue();
  });

  test('prefixes with homie_ when name does not start with a letter', () => {
    const u = suggestTelegramBotUsername('  123  ');
    expect(u.startsWith('homie_')).toBeTrue();
    expect(u.endsWith('_bot')).toBeTrue();
  });
});

describe('extractTelegramBotDescription', () => {
  test('falls back when soulMd is missing', () => {
    const desc = extractTelegramBotDescription(null, 'Ava');
    expect(desc).toContain('Ava');
  });

  test('strips headings, bullets, and code fences', () => {
    const draft = makeDraft({
      soulMd: [
        '# SOUL',
        '',
        '- **Ava** is a friend.',
        '',
        '```',
        'do not include this',
        '```',
        '',
        '> warm and helpful',
        '',
        'See [docs](https://example.com).',
      ].join('\n'),
    });
    const desc = extractTelegramBotDescription(draft, 'Ava');
    expect(desc).not.toContain('#');
    expect(desc).not.toContain('```');
    expect(desc).not.toContain('do not include this');
    expect(desc).toContain('Ava is a friend.');
    expect(desc).toContain('warm and helpful');
    expect(desc).toContain('See docs.');
    expect(desc.length).toBeLessThanOrEqual(512);
  });
});

describe('extractTelegramBotShortDescription', () => {
  test('uses first trait when it fits', () => {
    const draft = makeDraft({
      personality: {
        traits: ['warm', 'curious', 'direct'],
        voiceRules: ['x', 'y', 'z'],
        antiPatterns: [],
      },
    });
    const short = extractTelegramBotShortDescription(draft, 'Ava');
    expect(short).toBe('Ava — warm');
    expect(short.length).toBeLessThanOrEqual(120);
  });

  test('falls back to friendName when trait is too long', () => {
    const draft = makeDraft({
      personality: {
        traits: ['x'.repeat(200), 'ok', 'ok2'],
        voiceRules: ['x', 'y', 'z'],
        antiPatterns: [],
      },
    });
    const short = extractTelegramBotShortDescription(draft, 'Ava');
    expect(short).toBe('Ava');
  });
});
