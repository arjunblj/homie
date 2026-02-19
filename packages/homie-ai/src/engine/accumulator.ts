import { looksLikeContinuation } from '../behavior/velocity.js';
import type { ChatId } from '../types/ids.js';

export interface AccumulatorConfig {
  readonly dmWindowMs: number;
  readonly groupWindowMs: number;
  readonly maxWaitMs: number;
  readonly maxMessages: number;
  readonly continuationMultiplier: number;
}

export const DEFAULT_ACCUMULATOR_CONFIG: AccumulatorConfig = {
  dmWindowMs: 2000,
  groupWindowMs: 3000,
  maxWaitMs: 10_000,
  maxMessages: 20,
  continuationMultiplier: 1.5,
};

export const ZERO_DEBOUNCE_CONFIG: AccumulatorConfig = {
  dmWindowMs: 0,
  groupWindowMs: 0,
  maxWaitMs: 0,
  maxMessages: Infinity,
  continuationMultiplier: 1,
};

interface BatchState {
  firstArrivalMs: number;
  count: number;
}

const COMMAND_PREFIX = /^\/\w/u;
const TERMINAL_PUNCTUATION = /[.!?;:)\]}>]$/u;

export function isShortUnterminated(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length < 20 && !TERMINAL_PUNCTUATION.test(t);
}

export function hasContinuationSignal(text: string): boolean {
  return looksLikeContinuation(text) || isShortUnterminated(text);
}

export function shouldFlushImmediately(opts: {
  readonly text: string;
  readonly isGroup: boolean;
  readonly mentioned?: boolean | undefined;
}): boolean {
  const t = opts.text.trim();
  if (COMMAND_PREFIX.test(t)) return true;
  if (opts.isGroup && opts.mentioned === true) return true;
  return false;
}

/**
 * Per-chat accumulating debounce.
 *
 * Instead of a fixed timer per message, each new message resets the debounce
 * timer for that chat. The timer fires when no new messages arrive within the
 * window, or when a hard cap (time / count) is hit.
 *
 * The caller still relies on stale-discard (responseSeq) for correctness;
 * the accumulator is a timing optimization that reduces unnecessary LLM calls.
 */
export class MessageAccumulator {
  private readonly batches = new Map<string, BatchState>();

  constructor(private readonly config: AccumulatorConfig = DEFAULT_ACCUMULATOR_CONFIG) {}

  /**
   * Returns the number of milliseconds to wait before processing, or 0 for
   * immediate flush.
   */
  public getDebounceMs(opts: {
    readonly chatId: ChatId;
    readonly text: string;
    readonly isGroup: boolean;
    readonly mentioned?: boolean | undefined;
    readonly nowMs?: number;
  }): number {
    const chatKey = String(opts.chatId);
    const now = opts.nowMs ?? Date.now();

    if (shouldFlushImmediately(opts)) {
      this.batches.delete(chatKey);
      return 0;
    }

    const existing = this.batches.get(chatKey);
    if (existing) {
      existing.count++;
      if (now - existing.firstArrivalMs >= this.config.maxWaitMs) {
        this.batches.delete(chatKey);
        return 0;
      }
      if (existing.count >= this.config.maxMessages) {
        this.batches.delete(chatKey);
        return 0;
      }
    } else {
      this.batches.set(chatKey, { firstArrivalMs: now, count: 1 });
    }

    const baseMs = opts.isGroup ? this.config.groupWindowMs : this.config.dmWindowMs;
    const window = hasContinuationSignal(opts.text)
      ? Math.floor(baseMs * this.config.continuationMultiplier)
      : baseMs;

    const state = this.batches.get(chatKey)!;
    const elapsed = now - state.firstArrivalMs;
    const remaining = this.config.maxWaitMs - elapsed;

    return Math.max(0, Math.min(window, remaining));
  }

  public clear(chatId: ChatId): void {
    this.batches.delete(String(chatId));
  }
}
