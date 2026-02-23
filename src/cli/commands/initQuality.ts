import type { IdentityDraft } from '../../interview/schemas.js';

export interface InterviewOperatorProfile {
  operatorName?: string;
  relationshipDynamic?: string;
  biographyDetails?: string;
  technicalDetails?: string;
  consistencyReferences?: string;
}

export interface IdentityQualityBreakdown {
  specificity: number;
  consistency: number;
  depth: number;
  uniqueness: number;
  operatorCoverage: number;
}

export interface IdentityQualityResult {
  overall: number;
  passes: boolean;
  issues: string[];
  breakdown: IdentityQualityBreakdown;
}

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));

const GENERIC_PATTERNS = [
  /\b(as an ai|great question|i'?d be happy to help|in summary)\b/iu,
  /\b(delve|multifaceted|landscape|interplay|tapestry|underscores)\b/iu,
  /\b(this is (so )?interesting|that is so interesting)\b/iu,
  /\bso basically\b/iu,
];

const countGenericHits = (fullText: string, antiPatterns: readonly string[]): number => {
  const antiPatternsLower = antiPatterns.map((a) => a.toLowerCase());
  let hits = 0;
  for (const pattern of GENERIC_PATTERNS) {
    const match = pattern.exec(fullText);
    if (!match) continue;
    const matchedWord = match[0].toLowerCase();
    const inAntiPattern = antiPatternsLower.some((a) => a.includes(matchedWord));
    if (inAntiPattern) continue;
    hits++;
  }
  return hits;
};

const TENSION_PATTERNS =
  /\b(contradiction|edge|paradox|tension|on one hand|but also|allergic to|despite|yet she|yet he|while also|torn between)\b/iu;

const lexicalDiversity = (text: string): number => {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
  if (tokens.length === 0) return 0;
  return new Set(tokens).size / tokens.length;
};

const containsAny = (haystack: string, needles: readonly string[]): boolean => {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
};

const splitKeywords = (text: string): string[] => {
  return text
    .split(/[,\n;]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .slice(0, 8);
};

const countSections = (md: string): number => {
  return (md.match(/^#{1,3}\s+/gmu) ?? []).length;
};

export const scoreIdentityDraft = (input: {
  draft: IdentityDraft;
  operatorProfile?: InterviewOperatorProfile | undefined;
}): IdentityQualityResult => {
  const { draft } = input;
  const operator = input.operatorProfile;
  const fullText = [draft.soulMd, draft.styleMd, draft.userMd, draft.firstMeetingMd].join('\n\n');
  const issues: string[] = [];

  const genericHits = countGenericHits(fullText, draft.personality.antiPatterns);
  const soulSections = countSections(draft.soulMd);
  const specificity = clamp(
    70 +
      Math.min(15, Math.round(draft.soulMd.length / 80)) +
      Math.min(10, soulSections * 3) -
      genericHits * 15 -
      (draft.personality.antiPatterns.length === 0 ? 8 : 0),
  );

  const traitCount = draft.personality.traits.length;
  const voiceRuleCount = draft.personality.voiceRules.length;
  const antiPatternCount = draft.personality.antiPatterns.length;

  const tensionSignal = TENSION_PATTERNS.test(`${draft.soulMd}\n${draft.userMd}`);
  const hasHardBoundary =
    antiPatternCount >= 4 ||
    /\b(boundary|hard boundary|never pretend|never expose|will not|won'?t)\b/iu.test(draft.soulMd);
  const hasConcreteOpinions = (draft.soulMd.match(/^\s*[-*]\s+/gmu) ?? []).length >= 3;
  const consistency = clamp(
    40 +
      (tensionSignal ? 20 : 0) +
      (hasHardBoundary ? 15 : 0) +
      (hasConcreteOpinions ? 10 : 0) +
      Math.min(15, Math.round(antiPatternCount * 1.5)),
  );

  const styleBullets = (draft.styleMd.match(/^\s*[-*]\s+/gmu) ?? []).length;
  const codeBlocks = (draft.styleMd.match(/```/gu) ?? []).length / 2;
  const userLines = (draft.styleMd.match(/\bUSER:\b/gu) ?? []).length;
  const assistantLines = (draft.styleMd.match(/\bASSISTANT:\b/gu) ?? []).length;
  const dialogueTurns = Math.min(userLines, assistantLines);
  const styleSections = countSections(draft.styleMd);
  const depth = clamp(
    20 +
      Math.min(25, Math.round(draft.soulMd.length / 100)) +
      Math.min(15, styleBullets * 2) +
      dialogueTurns * 8 +
      Math.min(10, Math.round(codeBlocks * 5)) +
      Math.min(10, styleSections * 3) +
      Math.min(10, Math.round(draft.firstMeetingMd.length / 40)),
  );

  const uniqueRatio = lexicalDiversity(fullText);
  const uniqueness = clamp(Math.round(uniqueRatio * 140));

  let operatorCoverage = 70;
  if (operator?.operatorName || operator?.relationshipDynamic) {
    const operatorTokens = [
      ...(operator.operatorName ? [operator.operatorName] : []),
      ...splitKeywords(operator.relationshipDynamic ?? ''),
    ];
    if (!containsAny(draft.userMd, operatorTokens)) {
      operatorCoverage -= 40;
      issues.push('USER.md does not clearly encode operator relationship details.');
    }
  }
  if (operator?.technicalDetails) {
    const technicalTokens = splitKeywords(operator.technicalDetails);
    if (technicalTokens.length > 0 && !containsAny(fullText, technicalTokens)) {
      operatorCoverage -= 25;
      issues.push('Technical details from interview are missing in the generated identity.');
    }
  }
  operatorCoverage = clamp(operatorCoverage);

  if (genericHits > 0) {
    issues.push('Draft still contains assistant/generic phrasing.');
  }
  if (!tensionSignal) {
    issues.push('Draft lacks personality tensions or contradictions that make it feel real.');
  }
  if (dialogueTurns < 2 && styleBullets < 3 && codeBlocks < 1) {
    issues.push(
      "STYLE.md needs concrete examples: dialogue snippets, sentence patterns, or do/don't lists.",
    );
  }
  if (draft.soulMd.length < 200) {
    issues.push(
      'SOUL.md is too short; add opinions, edges, contradictions, and specific care patterns.',
    );
  }
  if (traitCount < 5 || voiceRuleCount < 5) {
    issues.push(
      'personality.json should have at least 5 traits and 5 voice rules for a rich character.',
    );
  }
  if (antiPatternCount < 5) {
    issues.push('personality.json needs at least 5 anti-patterns to prevent generic AI voice.');
  }
  if (draft.firstMeetingMd.length < 40) {
    issues.push(
      'first-meeting.md should be a specific, in-character opener — not a generic greeting.',
    );
  }
  if (draft.userMd.length < 80) {
    issues.push('USER.md is too thin; add specific patterns, needs, and calibration notes.');
  }

  const overall = clamp(
    Math.round(
      specificity * 0.25 +
        consistency * 0.25 +
        depth * 0.25 +
        uniqueness * 0.15 +
        operatorCoverage * 0.1,
    ),
  );
  const passes = overall >= 70 && genericHits === 0;
  if (!passes && issues.length === 0) {
    issues.push('Identity quality score is below threshold.');
  }

  return {
    overall,
    passes,
    issues,
    breakdown: {
      specificity,
      consistency,
      depth,
      uniqueness,
      operatorCoverage,
    },
  };
};
