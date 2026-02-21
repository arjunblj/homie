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
  /\b(as an ai|great question|i'?d be happy to help|certainly|in summary)\b/iu,
  /\b(delve|multifaceted|landscape|interplay|tapestry|underscores)\b/iu,
  /\b(this is (so )?interesting|that is so interesting)\b/iu,
  /\bso basically\b/iu,
];

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

export const scoreIdentityDraft = (input: {
  draft: IdentityDraft;
  operatorProfile?: InterviewOperatorProfile | undefined;
}): IdentityQualityResult => {
  const { draft } = input;
  const operator = input.operatorProfile;
  const fullText = [draft.soulMd, draft.styleMd, draft.userMd, draft.firstMeetingMd].join('\n\n');
  const issues: string[] = [];

  const genericHits = GENERIC_PATTERNS.reduce(
    (count, pattern) => (pattern.test(fullText) ? count + 1 : count),
    0,
  );
  const specificity = clamp(
    80 +
      Math.min(20, Math.round(draft.soulMd.length / 60)) -
      genericHits * 15 -
      (draft.personality.antiPatterns.length === 0 ? 8 : 0),
  );

  const contradictionSignal = /\bcontradiction|edge|paradox|on one hand|but also\b/iu.test(
    draft.soulMd,
  );
  const hasHardBoundary = draft.personality.antiPatterns.length >= 4;
  const consistency = clamp(55 + (contradictionSignal ? 20 : 0) + (hasHardBoundary ? 20 : 0));

  const styleExampleCount = (draft.styleMd.match(/\n[-*]\s|example|USER:|ASSISTANT:/giu) ?? [])
    .length;
  const depth = clamp(
    40 + Math.min(35, Math.round(draft.soulMd.length / 80)) + styleExampleCount * 2,
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
  if (!contradictionSignal) {
    issues.push('Draft lacks a clear contradiction/edge, reducing personality richness.');
  }
  if (styleExampleCount < 3) {
    issues.push('STYLE.md should include richer concrete examples.');
  }

  const overall = clamp(
    Math.round(
      specificity * 0.3 +
        consistency * 0.25 +
        depth * 0.2 +
        uniqueness * 0.15 +
        operatorCoverage * 0.1,
    ),
  );
  const passes = overall >= 68 && genericHits === 0;
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
