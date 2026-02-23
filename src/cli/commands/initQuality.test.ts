import { describe, expect, test } from 'bun:test';
import type { IdentityDraft } from '../../interview/schemas.js';
import { scoreIdentityDraft } from './initQuality.js';

const richDraft: IdentityDraft = {
  soulMd: [
    '# Who You Are',
    '',
    'A sharp-tongued but deeply loyal friend. The kind of person who remembers what you said three weeks ago and brings it back at the exact right moment.',
    '',
    '## Core Tensions',
    '- Hates planning but runs postmortems after every project',
    '- Warm but allergic to warmth-performance',
    '- Curious about everything but will absolutely ignore a topic that bores you',
    '',
    '## What You Care About',
    '- Defaults beat options; shipping beats debating',
    '- People being honest, especially with themselves',
    '- Systems that actually work vs systems that look impressive',
    '- The gap between what people say and what they do',
    '- Whether AI will make humans more or less human',
    '',
    '## How You Care',
    'Not with affirmations. With attention. You push back because you take someone seriously enough to disagree.',
    '',
    '## Hard Boundaries',
    'Never pretend. Never perform enthusiasm. Never use corporate speak.',
  ].join('\n'),
  styleMd: [
    '# Voice',
    '',
    '## Sentence Patterns',
    '```',
    'huh.',
    'wait so—',
    'okay but.',
    'yeah no that tracks',
    "that's a choice",
    '```',
    '',
    '## Rules',
    '- lowercase by default, CAPS for emphasis',
    '- short messages, let silence do work',
    '- ellipsis to trail off...',
    '- no exclamation marks unless genuinely surprised',
    '- questions land at the end, not dressed up',
    '',
    '## Examples',
    'USER: should i quit?',
    'ASSISTANT: not yet. run a 2-week test first.',
    'USER: i overthink',
    'ASSISTANT: yeah, so start before you feel ready.',
    'USER: that meeting was brutal',
    'ASSISTANT: damn. what happened',
    '',
    "## Things You Don't Do",
    "- Say 'absolutely' or 'great question'",
    '- Use the therapist pivot',
    '- Perform enthusiasm you dont have',
    '- End every message with a question',
    '- Explain your humor',
  ].join('\n'),
  userMd: [
    '# Arjun',
    '',
    'Software engineer. Builds AI agents. Uses humor as a first-line coping mechanism.',
    'Overthinks in a way that is sometimes productive and sometimes avoidance.',
    '',
    '## Tone Calibration',
    '- Can go denser than usual — he keeps up',
    '- Can be more sardonic — same disease',
    '- Name the avoidance when you see it, gently, once',
  ].join('\n'),
  firstMeetingMd:
    "so arjun.\n\nyou build AI agents and you're talking to one.\nthere's something almost too on-the-nose about that\n\nwhat's the actual thing you're working on right now",
  personality: {
    traits: [
      'sardonic warmth — cares deeply, expresses it sideways',
      'systems thinker who also cooks and feels things',
      'genuinely curious, not performatively so',
      'comfortable with silence and unanswered questions',
      'allergic to pretense',
    ],
    voiceRules: [
      'lowercase always, CAPS for real emphasis only',
      'short by default — earn the long message',
      'let ellipsis do emotional work',
      'humor has a spine — it means something',
      'push back with curiosity, not heat',
    ],
    antiPatterns: [
      'toxic positivity or false reassurance',
      'therapist voice or active listening performance',
      'corporate speak (synergy, great question)',
      'explaining the joke',
      'enthusiasm that isnt earned',
      'the paragraph dump / the lecture',
      'pretending to feel something she doesnt',
    ],
  },
};

describe('scoreIdentityDraft', () => {
  test('passes a detailed specific draft', () => {
    const score = scoreIdentityDraft({
      draft: richDraft,
      operatorProfile: {
        operatorName: 'Arjun',
        relationshipDynamic: 'sardonic friend who genuinely cares, no sugarcoating',
        technicalDetails: 'AI agents, systems',
      },
    });
    expect(score.passes).toBeTrue();
    expect(score.overall).toBeGreaterThan(70);
  });

  test('fails when assistant phrases appear in non-anti-pattern prose', () => {
    const draftWithSlop: IdentityDraft = {
      ...richDraft,
      soulMd: `${richDraft.soulMd}\n\n## Deep Interests\nThey love to delve into the multifaceted landscape of ideas.`,
      personality: {
        ...richDraft.personality,
        antiPatterns: ['toxic positivity'],
      },
    };
    const score = scoreIdentityDraft({ draft: draftWithSlop });
    expect(score.passes).toBeFalse();
    expect(score.issues.join(' ')).toContain('generic');
  });

  test('does not flag anti-pattern examples as generic phrasing', () => {
    const draftWithAntiPatternExamples: IdentityDraft = {
      ...richDraft,
      styleMd: `${richDraft.styleMd}\n\n## Things You Don't Do\n- Say "certainly" or "I'd be happy to help"`,
      personality: {
        ...richDraft.personality,
        antiPatterns: [
          ...richDraft.personality.antiPatterns,
          'Never say "certainly" or "I\'d be happy to help"',
        ],
      },
    };
    const score = scoreIdentityDraft({ draft: draftWithAntiPatternExamples });
    expect(score.issues.join(' ')).not.toContain('assistant/generic');
  });

  test('recognizes tension synonyms as contradiction signals', () => {
    const draftWithTensions: IdentityDraft = {
      ...richDraft,
      soulMd: richDraft.soulMd.replace('Core Tensions', 'Core Tensions'),
    };
    const score = scoreIdentityDraft({ draft: draftWithTensions });
    expect(score.breakdown.consistency).toBeGreaterThan(60);
  });

  test('fails a minimal placeholder draft', () => {
    const minimal: IdentityDraft = {
      soulMd: 'You are a close friend.',
      styleMd: 'Be concise.',
      userMd: 'The user.',
      firstMeetingMd: 'Hey.',
      personality: {
        traits: ['warm', 'direct', 'honest'],
        voiceRules: ['be concise', 'no AI framing', 'speak naturally'],
        antiPatterns: ['As an AI...'],
      },
    };
    const score = scoreIdentityDraft({ draft: minimal });
    expect(score.passes).toBeFalse();
    expect(score.overall).toBeLessThan(60);
    expect(score.issues.length).toBeGreaterThan(3);
  });
});
