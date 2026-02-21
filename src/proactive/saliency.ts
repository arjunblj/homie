import type { MemoryStore } from '../memory/store.js';
import type { PersonId } from '../types/ids.js';

export interface SaliencyCandidate {
  readonly content: string;
  readonly recency: number;
  readonly emotional: number;
  readonly unresolved: number;
}

export interface SaliencyResult {
  readonly score: number;
  readonly subject: string;
}

const SALIENCY_WEIGHTS = {
  recency: 0.35,
  emotional: 0.35,
  unresolved: 0.3,
} as const;

export const SALIENCY_THRESHOLD = 0.3;

const NEGATIVE_MOOD_PATTERNS = /stressed|worried|upset|anxious|frustrated|sad|overwhelmed|down/i;
const UNRESOLVED_PATTERNS =
  /waiting for|hoping to|trying to|going to|planning to|interview|applying|test|exam|results|decision|doctor|appointment|meeting|deadline|launch|release/i;

const FOURTEEN_DAYS_MS = 14 * 86_400_000;

export function scoreSaliency(candidate: SaliencyCandidate): number {
  return (
    SALIENCY_WEIGHTS.recency * candidate.recency +
    SALIENCY_WEIGHTS.emotional * candidate.emotional +
    SALIENCY_WEIGHTS.unresolved * candidate.unresolved
  );
}

function emotionalWeight(moodSignal: string | null): number {
  if (!moodSignal) return 0.3;
  return NEGATIVE_MOOD_PATTERNS.test(moodSignal) ? 1.0 : 0.5;
}

function factRecency(createdAtMs: number, nowMs: number): number {
  const ageMs = nowMs - createdAtMs;
  return Math.max(0, 1 - ageMs / FOURTEEN_DAYS_MS);
}

function unresolvedWeightFromText(text: string): number {
  const t = text.trim();
  if (!t) return 0.2;
  return UNRESOLVED_PATTERNS.test(t) ? 1.0 : 0.3;
}

/**
 * Finds the highest-saliency subject for proactive check-ins/follow-ups.
 * Used by the turn engine's proactive flow to enrich event subjects.
 */
export async function findSalientSubject(opts: {
  readonly store: MemoryStore;
  readonly personId: PersonId;
  readonly nowMs?: number;
}): Promise<SaliencyResult | null> {
  const now = opts.nowMs ?? Date.now();
  const [structured, facts] = await Promise.all([
    opts.store.getStructuredPersonData(opts.personId),
    opts.store.getFactsForPerson(opts.personId, 30),
  ]);

  const emotional = emotionalWeight(structured.lastMoodSignal);

  const candidates: SaliencyCandidate[] = [];

  for (const c of structured.currentConcerns) {
    candidates.push({ content: c, recency: 1.0, emotional, unresolved: 1.0 });
  }
  for (const g of structured.goals) {
    candidates.push({
      content: g,
      recency: 0.7,
      emotional,
      unresolved: unresolvedWeightFromText(g),
    });
  }
  for (const f of facts) {
    candidates.push({
      content: f.content,
      recency: factRecency(f.createdAtMs, now),
      emotional,
      unresolved: unresolvedWeightFromText(f.content),
    });
  }

  let best: SaliencyResult | null = null;
  for (const c of candidates) {
    const score = scoreSaliency(c);
    if (score >= SALIENCY_THRESHOLD && (!best || score > best.score)) {
      best = { score, subject: c.content };
    }
  }
  return best;
}
