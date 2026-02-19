import type { LLMBackend } from '../backend/types.js';
import type { HomieConfig } from '../config/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { LessonType } from '../memory/types.js';
import { asPersonId } from '../types/ids.js';
import { IntervalLoop } from '../util/intervalLoop.js';
import { errorFields, log } from '../util/logger.js';
import { type FeedbackSignals, scoreFeedback } from './scoring.js';
import type { PendingOutgoingRow, SqliteFeedbackStore } from './sqlite.js';
import type { IncomingReactionEvent, IncomingReplyEvent, TrackedOutgoing } from './types.js';

const LESSON_SCHEMA_HINT =
  '{ type: "success"|"failure"|"observation", why: string, lesson: string, alternative: string|null, rule: string|null, confidence: number }';

export class FeedbackTracker {
  private readonly logger = log.child({ component: 'feedback' });
  private readonly store: SqliteFeedbackStore;
  private readonly backend: LLMBackend;
  private readonly memory: MemoryStore;
  private readonly config: HomieConfig;
  private loop: IntervalLoop | undefined;
  private readonly signal?: AbortSignal | undefined;

  public constructor(opts: {
    store: SqliteFeedbackStore;
    backend: LLMBackend;
    memory: MemoryStore;
    config: HomieConfig;
    signal?: AbortSignal | undefined;
  }) {
    this.store = opts.store;
    this.backend = opts.backend;
    this.memory = opts.memory;
    this.config = opts.config;
    this.signal = opts.signal;
  }

  public start(): void {
    if (!this.config.memory.enabled || !this.config.memory.feedback.enabled) return;
    if (this.loop) return;
    this.loop = new IntervalLoop({
      name: 'feedback',
      everyMs: 30_000,
      tick: async (nowMs) => {
        await this.tick(nowMs);
      },
      signal: this.signal,
    });
    this.loop.start();
  }

  public stop(): void {
    this.loop?.stop();
    this.loop = undefined;
  }

  public close(): void {
    this.stop();
    try {
      this.store.close();
    } catch (err) {
      this.logger.error('close.error', errorFields(err));
    }
  }

  public healthCheck(): void {
    this.loop?.healthCheck();
  }

  public onOutgoingSent(o: TrackedOutgoing): void {
    if (!this.config.memory.enabled || !this.config.memory.feedback.enabled) return;
    try {
      this.store.registerOutgoing(o);
    } catch (err) {
      this.logger.error('registerOutgoing.error', errorFields(err));
    }
  }

  public onIncomingReply(ev: IncomingReplyEvent): void {
    if (!this.config.memory.enabled || !this.config.memory.feedback.enabled) return;
    try {
      this.store.recordIncomingReply(ev);

      if (ev.replyToRefKey && isRefinement(ev.text)) {
        this.store.markRefinement(ev.replyToRefKey);
      }
    } catch (err) {
      this.logger.error('recordIncomingReply.error', errorFields(err));
    }
  }

  public onIncomingReaction(ev: IncomingReactionEvent): void {
    if (!this.config.memory.enabled || !this.config.memory.feedback.enabled) return;
    try {
      this.store.recordIncomingReaction(ev);
    } catch (err) {
      this.logger.error('recordIncomingReaction.error', errorFields(err));
    }
  }

  public async tick(nowMs: number = Date.now(), limit?: number | undefined): Promise<number> {
    if (!this.config.memory.enabled || !this.config.memory.feedback.enabled) return 0;
    let due = this.store.listDueFinalizations(nowMs, this.config.memory.feedback.finalizeAfterMs);
    if (limit != null && limit > 0) due = due.slice(0, limit);
    for (const row of due) {
      await this.finalizeOne(row, nowMs);
    }
    return due.length;
  }

  private async finalizeOne(row: PendingOutgoingRow, nowMs: number): Promise<void> {
    const replies = this.store.getReplySignals(row.id, row.sent_at_ms);
    const reactions = this.store.getReactionSignals(row.ref_key, nowMs);
    const signals: FeedbackSignals = {
      isGroup: row.is_group === 1,
      timeToFirstResponseMs: replies.timeToFirstResponseMs,
      responseCount: replies.responseCount,
      reactionCount: reactions.reactionCount,
      negativeReactionCount: reactions.negativeReactionCount,
      reactionNetScore: reactions.reactionNetScore,
      refinement: row.refinement === 1,
      outgoingEndsWithQuestion: row.text.trimEnd().endsWith('?'),
    };
    const scored = scoreFeedback(signals);
    this.store.finalize(row.id, nowMs, scored);

    if (row.lesson_logged === 1) return;
    if (
      scored.score < this.config.memory.feedback.failureThreshold ||
      scored.score > this.config.memory.feedback.successThreshold
    ) {
      await this.synthesizeAndLogLesson(row, scored.score, scored.reasons);
      this.store.markLessonLogged(row.id);
    }
  }

  private async synthesizeAndLogLesson(
    row: PendingOutgoingRow,
    score: number,
    reasons: string[],
  ): Promise<void> {
    const type: LessonType =
      score <= this.config.memory.feedback.failureThreshold ? 'failure' : 'success';

    const sys = [
      'You are distilling a behavioral lesson for an AI friend agent.',
      'The goal is to improve future social interactions.',
      '',
      'QUALITY BAR — only write a lesson if ALL of these are true:',
      '- It is SPECIFIC to something that actually happened (not a generic principle)',
      '- It would change behavior if applied (not "be nicer" — what SPECIFICALLY to do differently)',
      '- The context makes it clear WHY this worked/failed',
      '- It is not already obvious from common sense ("respond to questions")',
      '',
      'DO NOT write lessons that are:',
      '- Restatements of common sense ("be helpful", "respond when asked")',
      '- Too vague to act on ("adjust communication style based on context")',
      '- About topics/facts rather than behavioral patterns',
      '',
      'For failures and observations, specify what the agent SHOULD have done instead in the "alternative" field.',
      '',
      'Confidence calibration:',
      '- 0.9+: Clear cause-and-effect, direct feedback from others',
      '- 0.7-0.9: Strong signal from reactions/engagement',
      '- 0.5-0.7: Reasonable inference but no direct feedback',
      '- <0.5: Speculative — set to 0.4 and we will filter it downstream',
      '',
      `Return strict JSON matching: ${LESSON_SCHEMA_HINT}`,
    ].join('\n');

    const user = [
      `Channel: ${row.channel}`,
      `Group: ${row.is_group === 1 ? 'yes' : 'no'}`,
      `Score: ${score}`,
      `Reasons: ${reasons.join(', ')}`,
      '',
      'Outgoing message:',
      row.text,
      '',
      'Reply samples (may be empty):',
      row.sample_replies_json ?? '[]',
      '',
      'Reaction samples (may be empty):',
      row.sample_reactions_json ?? '[]',
    ].join('\n');

    const res = await this.backend.complete({
      role: 'default',
      maxSteps: 2,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    });

    const parsed = safeJsonParse(res.text) as
      | {
          type?: string;
          why?: string;
          lesson?: string;
          alternative?: string | null;
          rule?: string | null;
          confidence?: number;
        }
      | undefined;

    const why = typeof parsed?.why === 'string' ? parsed.why.trim() : '';
    const lesson = typeof parsed?.lesson === 'string' ? parsed.lesson.trim() : '';
    const alternative = typeof parsed?.alternative === 'string' ? parsed.alternative.trim() : null;
    const rule = typeof parsed?.rule === 'string' ? parsed.rule.trim() : null;
    const conf = typeof parsed?.confidence === 'number' ? parsed.confidence : undefined;

    const content = [
      `Outcome score: ${score} (${reasons.join(', ')})`,
      why ? `Why: ${why}` : '',
      lesson ? `Lesson: ${lesson}` : '',
      alternative ? `Alternative: ${alternative}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const personId =
      row.primary_channel_user_id && row.primary_channel_user_id.trim().length > 0
        ? asPersonId(`person:${row.primary_channel_user_id.trim()}`)
        : undefined;

    try {
      await this.memory.logLesson({
        type,
        category: 'behavioral_feedback',
        content,
        ...(rule ? { rule } : {}),
        ...(alternative ? { alternative } : {}),
        ...(personId ? { personId } : {}),
        ...(conf != null ? { confidence: conf } : {}),
        createdAtMs: nowMs(),
      });
    } catch (err) {
      this.logger.error('logLesson.error', errorFields(err));
    }
  }
}

function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    void err;
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (err2) {
        void err2;
        return undefined;
      }
    }
    return undefined;
  }
}

function nowMs(): number {
  return Date.now();
}

const REFINEMENT_PATTERN =
  /^(actually\b|no[,.]\s|i meant\b|what i meant\b|not what i\b|that's not what\b|sorry,?\s+i meant)/iu;

export function isRefinement(text: string): boolean {
  return REFINEMENT_PATTERN.test(text.trim());
}
