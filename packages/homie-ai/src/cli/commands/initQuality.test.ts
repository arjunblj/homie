import { describe, expect, test } from 'bun:test';
import type { IdentityDraft } from 'homie-interview-core';
import { scoreIdentityDraft } from './initQuality.js';

const baseDraft: IdentityDraft = {
  soulMd: [
    '# SOUL',
    'A sharp-tongued but deeply loyal friend.',
    'Contradiction: hates planning but runs postmortems after every project.',
    'Strong opinions: defaults beat options; shipping beats debating.',
  ].join('\n'),
  styleMd: [
    '# STYLE',
    '- short lines, lowercase, no list-y assistant tone',
    'USER: should i quit?',
    'ASSISTANT: not yet. run a 2-week test first.',
    'USER: i overthink',
    'ASSISTANT: yeah, so start before you feel ready.',
  ].join('\n'),
  userMd: '# USER\nOperator: Arjun. Dynamic: blunt trust, high-context shorthand.',
  firstMeetingMd: 'yo. i remember your last sprint spiral. what are we fixing first?',
  personality: {
    traits: ['blunt', 'loyal', 'funny'],
    voiceRules: ['short lines', 'no assistant framing', 'direct disagreement'],
    antiPatterns: ['as an ai', 'great question', 'so basically', 'certainly'],
  },
};

describe('scoreIdentityDraft', () => {
  test('passes a detailed specific draft', () => {
    const score = scoreIdentityDraft({
      draft: baseDraft,
      operatorProfile: {
        operatorName: 'Arjun',
        relationshipDynamic: 'blunt trust, high-context shorthand',
        technicalDetails: 'typescript, infra, distributed systems',
      },
    });
    expect(score.passes).toBeTrue();
    expect(score.overall).toBeGreaterThan(68);
  });

  test('fails when assistant phrases are present', () => {
    const score = scoreIdentityDraft({
      draft: {
        ...baseDraft,
        soulMd: `${baseDraft.soulMd}\nAs an AI, I would be happy to help with anything.`,
      },
    });
    expect(score.passes).toBeFalse();
    expect(score.issues.join(' ')).toContain('assistant');
  });
});
