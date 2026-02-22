import type { IncomingMessage } from '../agent/types.js';
import type { SessionMessage } from '../session/types.js';

export type MessageType = 'mentioned_question' | 'mentioned_casual' | 'has_link' | 'general';

export type EngagementAction = 'send' | 'react' | 'silence';

export interface ChatHeat {
  /** 0-1. Higher means "we've been active recently"; decays over time. */
  heat: number;
  ourRecentCount: number;
  totalRecentCount: number;
  lastOurMessageMs: number;
}

const HALF_LIFE_MS = 5 * 60_000;
const REACTION_WEIGHT = 0.25;
const RECENT_WINDOW = 20;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function classifyMessageType(
  msg: Pick<IncomingMessage, 'mentioned'>,
  text: string,
): MessageType {
  if (msg.mentioned === true) {
    if (/\?/u.test(text)) return 'mentioned_question';
    return 'mentioned_casual';
  }
  if (/(https?:\/\/|www\.)\S+/iu.test(text)) return 'has_link';
  return 'general';
}

export function detectThreadLock(messages: SessionMessage[]): boolean {
  const recent = messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-8);
  if (recent.length < 6) return false;

  const authors = recent.map((m) => (m.role === 'assistant' ? '__self__' : m.authorId));
  const unique = new Set(authors.filter(Boolean));
  return unique.size === 2 && unique.has('__self__');
}

export interface ParticipationStats {
  groupSizeEstimate: number;
  ourShare: number; // 0-1
  shareThreshold: number; // 0-1
  ourRecentCount: number;
  totalRecentCount: number;
  lastOurMessageMs: number;
}

export function computeParticipationStats(messages: SessionMessage[]): ParticipationStats {
  const recent = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-RECENT_WINDOW);

  let totalWeight = 0;
  let ourWeight = 0;
  let ourRecentCount = 0;
  let totalRecentCount = 0;
  let lastOurMessageMs = 0;

  for (const m of recent) {
    totalRecentCount += 1;
    if (m.role === 'assistant') {
      ourRecentCount += 1;
      lastOurMessageMs = Math.max(lastOurMessageMs, m.createdAtMs);
    }

    if (m.role === 'user') {
      totalWeight += 1;
      continue;
    }

    // Treat reactions as lighter participation than full messages.
    const w =
      m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[REACTION]')
        ? REACTION_WEIGHT
        : 1;
    totalWeight += w;
    ourWeight += w;
  }

  const distinctAuthors = new Set(
    recent
      .filter((m) => m.role === 'user')
      .map((m) => m.authorId)
      .filter(Boolean),
  ).size;

  const groupSizeEstimate = Math.max(2, distinctAuthors + 1);
  const shareThreshold = groupSizeEstimate <= 4 ? 0.3 : groupSizeEstimate <= 7 ? 0.2 : 0.15;
  const ourShare = totalWeight > 0 ? ourWeight / totalWeight : 0;

  return {
    groupSizeEstimate,
    ourShare,
    shareThreshold,
    ourRecentCount,
    totalRecentCount,
    lastOurMessageMs,
  };
}

export function shouldSilenceForDomination(stats: ParticipationStats): boolean {
  return stats.ourShare > stats.shareThreshold;
}

export function computeHeat(messages: SessionMessage[], nowMs: number): ChatHeat {
  const stats = computeParticipationStats(messages);
  const timeSinceLastOur =
    stats.lastOurMessageMs > 0 ? Math.max(0, nowMs - stats.lastOurMessageMs) : 0;
  const decay = stats.lastOurMessageMs > 0 ? Math.exp(-timeSinceLastOur / HALF_LIFE_MS) : 0;

  // Normalize against the domination threshold so "near dominating" is hot.
  const normalizedShare = stats.shareThreshold > 0 ? stats.ourShare / stats.shareThreshold : 0;
  const heat = clamp01(normalizedShare) * decay;

  return {
    heat,
    ourRecentCount: stats.ourRecentCount,
    totalRecentCount: stats.totalRecentCount,
    lastOurMessageMs: stats.lastOurMessageMs,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

export function rollEngagement(
  heat: number,
  messageType: Exclude<MessageType, 'mentioned_question' | 'mentioned_casual'>,
  participationRate: number,
  rng01: number,
): EngagementAction {
  // heat=0 => cold (we've been quiet recently), heat=1 => hot (we've been active recently)
  // participationRate is "how over target we are": 1 is on-target, >1 means overparticipating.
  const h = clamp01(heat);
  const p = Math.max(0, participationRate);

  const base = (() => {
    switch (messageType) {
      case 'has_link':
        return {
          send: lerp(0.08, 0.04, h),
          react: lerp(0.12, 0.08, h),
        };
      case 'general':
        return {
          // Spec example: cold => 8% send, 20% react, 72% silence.
          send: lerp(0.08, 0.03, h),
          react: lerp(0.2, 0.12, h),
        };
    }
  })();

  // Suppress sending when we're over the 1/n participation target.
  const sendSuppression = p > 1 ? 1 / p : 1;
  const send = clamp01(base.send * sendSuppression);
  const react = clamp01(base.react);

  const r = clamp01(rng01);
  if (r < send) return 'send';
  if (r < send + react) return 'react';
  return 'silence';
}

export function participationRateToTarget(stats: ParticipationStats): number {
  const targetShare = 1 / stats.groupSizeEstimate;
  if (targetShare <= 0) return 1;
  return stats.ourShare / targetShare;
}
