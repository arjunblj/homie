import type { ChatTrustTier } from '../trust/types.js';
import type { ChatId, EpisodeId, FactId, LessonId, PersonId } from '../types/ids.js';

export type RelationshipStage = 'new' | 'acquaintance' | 'friend' | 'close';

export interface PersonRecord {
  id: PersonId;
  displayName: string;
  channel: string;
  channelUserId: string;
  relationshipStage: RelationshipStage;
  /**
   * Continuous relationship strength in [0, 1]. Used for gating (trust, proactive)
   * and prompt framing. Stage can remain as a coarse derived label.
   */
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

export interface Lesson {
  id?: LessonId;
  /** Discriminates the kind of behavioral signal. */
  type?: LessonType | undefined;
  category: string;
  content: string;
  /** Distilled generalizable rule (if applicable). */
  rule?: string | undefined;
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
