export interface FeedbackSignals {
  readonly isGroup: boolean;
  readonly timeToFirstResponseMs?: number | undefined;
  readonly responseCount: number;
  readonly reactionCount: number;
  readonly negativeReactionCount: number;
  /** Net reaction sentiment (-1..1ish). */
  readonly reactionNetScore: number;
  /** True when the first reply is a refinement ("actually, I meant..."). */
  readonly refinement?: boolean | undefined;
  /** Whether the outgoing message ended with a question. */
  readonly outgoingEndsWithQuestion?: boolean | undefined;
}

export interface FeedbackScore {
  readonly score: number; // roughly -1..1
  readonly reasons: string[];
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const EMOJI_SCORES: Record<string, number> = {
  '❤️': 0.5,
  '❤': 0.5,
  '👍': 0.35,
  '🔥': 0.25,
  '🎉': 0.25,
  '👏': 0.2,
  '😂': 0.15,
  '😄': 0.15,
  '😊': 0.15,

  '😕': -0.15,
  '😬': -0.2,
  '🙄': -0.25,
  '😡': -0.5,
  '👎': -0.5,
  '🤮': -0.8,
  '💩': -0.9,
};

export const emojiFeedbackScore = (emoji: string): number => EMOJI_SCORES[emoji] ?? 0;

export const isNegativeEmoji = (emoji: string): boolean => emojiFeedbackScore(emoji) < 0;

export const scoreFeedback = (s: FeedbackSignals): FeedbackScore => {
  const reasons: string[] = [];
  let score = 0;

  // Response time is the strongest signal for friend agents (feels "seen").
  // No response is a mild signal, not a failure on its own — people don't reply
  // to "goodnight" or "haha yeah." Only compound with other negatives.
  const t = s.timeToFirstResponseMs;
  if (t === undefined) {
    if (s.outgoingEndsWithQuestion) {
      score -= 0.15;
      reasons.push('no_response_to_question');
    } else {
      reasons.push('no_response_to_statement');
    }
  } else if (t <= 30_000) {
    score += 0.3;
    reasons.push('quick_response');
  } else if (t <= 2 * 60_000) {
    score += 0.2;
    reasons.push('fast_response');
  } else if (t <= 10 * 60_000) {
    score += 0.1;
    reasons.push('eventual_response');
  } else if (t >= 30 * 60_000) {
    score -= 0.1;
    reasons.push('slow_response');
  }

  if (s.responseCount >= 1) {
    score += 0.2;
    reasons.push('got_reply');
  }
  if (s.responseCount >= 2) {
    score += 0.2;
    reasons.push('conversation_continued');
  }

  if (s.reactionCount > 0) {
    const boost = 0.03 * Math.min(6, s.reactionCount);
    score += boost;
    reasons.push('got_reactions');
  }

  if (s.negativeReactionCount > 0) {
    const penalty = 0.2 * Math.min(3, s.negativeReactionCount);
    score -= penalty;
    reasons.push('negative_reactions');
  }

  if (Math.abs(s.reactionNetScore) >= 0.2) {
    score += clamp(s.reactionNetScore, -0.5, 0.5);
    reasons.push(s.reactionNetScore >= 0 ? 'positive_reactions' : 'negative_reactions_net');
  }

  if (s.refinement) {
    score -= 0.2;
    reasons.push('refinement');
  }

  // Group chats are noisier; dampen the magnitude.
  if (s.isGroup) score *= 0.7;

  return { score: clamp(score, -1, 1), reasons };
};
