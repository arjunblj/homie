import type { IncomingMessage } from '../agent/types.js';
import { looksLikeContinuation } from '../behavior/velocity.js';
import type { ChatId } from '../types/ids.js';

export interface AccumulatorConfig {
  readonly dmWindowMs: number;
  readonly groupWindowMs: number;
  readonly maxWaitMs: number;
  readonly maxMessages: number;
  readonly continuationMultiplier: number;
}

const DEFAULT_ACCUMULATOR_CONFIG: AccumulatorConfig = {
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
  messages: IncomingMessage[];
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
  readonly hasAttachments?: boolean | undefined;
}): boolean {
  const t = opts.text.trim();
  if (COMMAND_PREFIX.test(t)) return true;
  if (opts.hasAttachments) return true;
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
   * Pushes a message into the current batch and returns the debounce duration.
   * The caller should wait for that duration and then drain/process the batch.
   */
  public pushAndGetDebounceMs(opts: {
    readonly msg: IncomingMessage;
    readonly nowMs?: number;
  }): number {
    const chatKey = String(opts.msg.chatId);
    const now = opts.nowMs ?? Date.now();

    const trimmed = opts.msg.text.trim();
    const isCommand = COMMAND_PREFIX.test(trimmed);

    const state = this.batches.get(chatKey);
    if (state) {
      state.messages.push(opts.msg);
    } else {
      this.batches.set(chatKey, { firstArrivalMs: now, messages: [opts.msg] });
    }

    const count = this.batches.get(chatKey)?.messages.length ?? 1;
    const elapsed = now - (this.batches.get(chatKey)?.firstArrivalMs ?? now);

    if (
      shouldFlushImmediately({
        text: trimmed,
        isGroup: opts.msg.isGroup,
        mentioned: opts.msg.mentioned,
        hasAttachments: Boolean(opts.msg.attachments?.length),
      })
    ) {
      // Commands are "out-of-band" and should not drag earlier chatter into the same batch.
      // Mentions/replies *should* include previous context in the burst.
      if (isCommand) {
        this.batches.set(chatKey, { firstArrivalMs: now, messages: [opts.msg] });
      }
      return 0;
    }

    if (elapsed >= this.config.maxWaitMs) return 0;
    if (count >= this.config.maxMessages) return 0;

    const baseMs = opts.msg.isGroup ? this.config.groupWindowMs : this.config.dmWindowMs;
    const window = hasContinuationSignal(opts.msg.text)
      ? Math.floor(baseMs * this.config.continuationMultiplier)
      : baseMs;

    const remaining = this.config.maxWaitMs - elapsed;

    return Math.max(0, Math.min(window, remaining));
  }

  public drain(chatId: ChatId): IncomingMessage[] {
    const chatKey = String(chatId);
    const existing = this.batches.get(chatKey);
    if (!existing) return [];
    this.batches.delete(chatKey);
    return existing.messages;
  }

  public clear(chatId: ChatId): void {
    this.batches.delete(String(chatId));
  }
}
