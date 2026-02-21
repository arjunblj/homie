import { scoreFeedback } from '../feedback/scoring.js';
import type { SqliteFeedbackStore } from '../feedback/sqlite.js';

export interface SelfImproveFeedbackConfig {
  enabled: boolean;
  finalizeAfterMs: number;
  successThreshold: number;
  failureThreshold: number;
}

export interface SelfImprovePlanRow {
  readonly outgoingId: number;
  readonly chatId: string;
  readonly channel: string;
  readonly refKey: string;
  readonly isGroup: boolean;
  readonly sentAtMs: number;
  readonly textPreview: string;
  readonly score: number;
  readonly reasons: string[];
  readonly willLogLesson: boolean;
}

export const planFeedbackSelfImprove = (opts: {
  store: SqliteFeedbackStore;
  config: SelfImproveFeedbackConfig;
  nowMs: number;
  limit?: number | undefined;
}): SelfImprovePlanRow[] => {
  if (!opts.config.enabled) return [];
  const limit = Math.max(1, Math.min(200, opts.limit ?? 25));
  const due = opts.store
    .listDueFinalizations(opts.nowMs, opts.config.finalizeAfterMs)
    .slice(0, limit);

  return due.map((row) => {
    const replies = opts.store.getReplySignals(row.id, row.sent_at_ms);
    const reactions = opts.store.getReactionSignals(row.ref_key, opts.nowMs);
    const scored = scoreFeedback({
      isGroup: row.is_group === 1,
      timeToFirstResponseMs: replies.timeToFirstResponseMs,
      responseCount: replies.responseCount,
      reactionCount: reactions.reactionCount,
      negativeReactionCount: reactions.negativeReactionCount,
      reactionNetScore: reactions.reactionNetScore,
    });

    const willLogLesson =
      row.lesson_logged !== 1 &&
      (scored.score < opts.config.failureThreshold || scored.score > opts.config.successThreshold);

    return {
      outgoingId: row.id,
      chatId: row.chat_id,
      channel: row.channel,
      refKey: row.ref_key,
      isGroup: row.is_group === 1,
      sentAtMs: row.sent_at_ms,
      textPreview: String(row.text ?? '')
        .trim()
        .replace(/\s+/gu, ' ')
        .slice(0, 160),
      score: scored.score,
      reasons: scored.reasons,
      willLogLesson,
    };
  });
};
