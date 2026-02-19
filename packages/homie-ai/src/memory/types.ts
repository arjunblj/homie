import { z } from 'zod';
import type { ChatId, EpisodeId, FactId, LessonId, PersonId } from '../types/ids.js';

export const ChatTrustTierValues = ['new_contact', 'getting_to_know', 'close_friend'] as const;
export type ChatTrustTier = (typeof ChatTrustTierValues)[number];
export const ChatTrustTierSchema: z.ZodType<ChatTrustTier> = z.enum(ChatTrustTierValues);

const CLOSE_FRIEND_THRESHOLD = 0.65;
const GETTING_TO_KNOW_THRESHOLD = 0.25;

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function deriveTrustTierFromScore(score: number): ChatTrustTier {
  const s = clamp01(score);
  if (s >= CLOSE_FRIEND_THRESHOLD) return 'close_friend';
  if (s >= GETTING_TO_KNOW_THRESHOLD) return 'getting_to_know';
  return 'new_contact';
}

export function deriveTrustTierForPerson(person: PersonRecord | null): ChatTrustTier {
  if (!person) return 'new_contact';
  if (person.trustTierOverride) return person.trustTierOverride;
  return deriveTrustTierFromScore(person.relationshipScore);
}

export interface PersonRecord {
  id: PersonId;
  displayName: string;
  channel: string;
  channelUserId: string;
  /** Continuous relationship strength in [0, 1]. Single source of truth for gating. */
  relationshipScore: number;
  /** Manual override for trust tier (operator-controlled). */
  trustTierOverride?: ChatTrustTier | undefined;
  /** Synthesized markdown summary regenerated during consolidation. */
  capsule?: string | undefined;
  /**
   * Cross-group safe steering derived only from group messages (not DMs).
   * Used in group turns as tone/style context; must never contain DM-private facts.
   */
  publicStyleCapsule?: string | undefined;
  /** Top concerns currently on this person's mind (max 5). */
  currentConcerns?: string[] | undefined;
  /** Longer-term goals the person has mentioned. */
  goals?: string[] | undefined;
  /** Explicit preferences (freeform key-value). */
  preferences?: Record<string, string> | undefined;
  /** Last observed emotional tone/mood signal. */
  lastMoodSignal?: string | undefined;
  /** Things the agent is curious about / wants to learn about this person. */
  curiosityQuestions?: string[] | undefined;
  createdAtMs: number;
  updatedAtMs: number;
}

export type FactCategory =
  | 'preference'
  | 'personal'
  | 'plan'
  | 'professional'
  | 'relationship'
  | 'misc';

export interface Fact {
  id?: FactId;
  personId?: PersonId;
  subject: string;
  content: string;
  category?: FactCategory | undefined;
  /** Quote from source conversation that grounds this fact. */
  evidenceQuote?: string | undefined;
  /** Epoch ms when this fact was last included in a context pack. */
  lastAccessedAtMs?: number | undefined;
  createdAtMs: number;
}

export interface Episode {
  id?: EpisodeId;
  chatId: ChatId;
  /** Optional person associated with the episode (author for user text). */
  personId?: PersonId | undefined;
  /** Whether this episode originated from a group chat turn. */
  isGroup?: boolean | undefined;
  content: string;
  createdAtMs: number;
}

export type LessonType = 'observation' | 'failure' | 'success' | 'pattern';

const LOG1P_60 = Math.log1p(60);

/** Intentionally non-decaying: scores only go up. Decay is a future consideration. */
export function scoreFromSignals(episodes: number, ageMs: number): number {
  const e = Math.max(0, Math.floor(episodes));
  const days = Math.max(0, ageMs / (24 * 60 * 60_000));
  const episodeComponent = Math.log1p(e) / LOG1P_60;
  const ageComponent = Math.min(1, days / 14);
  return clamp01(0.1 + 0.75 * episodeComponent + 0.15 * ageComponent);
}

export interface Lesson {
  id?: LessonId;
  /** Discriminates the kind of behavioral signal. */
  type?: LessonType | undefined;
  category: string;
  content: string;
  /** Distilled generalizable rule (if applicable). */
  rule?: string | undefined;
  /** What the agent should have done instead (for failure/observation lessons). */
  alternative?: string | undefined;
  /** Person this lesson applies to, or undefined for global lessons. */
  personId?: PersonId | undefined;
  /** Source episode IDs that contributed to this lesson. */
  episodeRefs?: string[] | undefined;
  /** 0–1 confidence in the lesson's validity. */
  confidence?: number | undefined;
  /** How many times this lesson was confirmed by subsequent feedback. */
  timesValidated?: number | undefined;
  /** How many times this lesson was contradicted by subsequent feedback. */
  timesViolated?: number | undefined;
  createdAtMs: number;
}
