import type { SessionStore } from '../session/types.js';
import type { ChatId } from '../types/ids.js';

export interface VelocitySnapshot {
  readonly recentCount: number;
  readonly windowMs: number;
  readonly avgGapMs: number;
  readonly isBurst: boolean;
  readonly isRapidDialogue: boolean;
  readonly isContinuation: boolean;
}

const CONTINUATION_PATTERNS = [
  /\.\.\.\s*$/u,
  /…\s*$/u,
  /\band\s*$/iu,
  /\bbut\s*$/iu,
  /\bor\s*$/iu,
  /\balso\s*$/iu,
  /\blike\s*$/iu,
  /\bso\s*$/iu,
  /,\s*$/u,
];

export const looksLikeContinuation = (text: string): boolean => {
  const t = text.trim();
  if (!t) return false;
  return CONTINUATION_PATTERNS.some((p) => p.test(t));
};

export const measureVelocity = (opts: {
  sessionStore: SessionStore | undefined;
  chatId: ChatId;
  windowMs?: number;
  nowMs?: number;
}): VelocitySnapshot => {
  const windowMs = opts.windowMs ?? 120_000;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - windowMs;

  const msgs = opts.sessionStore?.getMessages(opts.chatId, 50) ?? [];
  const recent = msgs.filter((m) => m.role === 'user' && m.createdAtMs >= cutoff);

  if (recent.length < 2) {
    return {
      recentCount: recent.length,
      windowMs,
      avgGapMs: windowMs,
      isBurst: false,
      isRapidDialogue: false,
      isContinuation: false,
    };
  }

  const timestamps = recent.map((m) => m.createdAtMs).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    gaps.push((timestamps[i] ?? 0) - (timestamps[i - 1] ?? 0));
  }
  const avgGapMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  const uniqueAuthors = new Set(recent.map((m) => m.authorId).filter(Boolean));
  const isRapidDialogue = uniqueAuthors.size >= 2 && avgGapMs < 15_000;

  const lastMsg = recent.at(-1);
  const isContinuation = lastMsg ? looksLikeContinuation(lastMsg.content) : false;

  return {
    recentCount: recent.length,
    windowMs,
    avgGapMs,
    isBurst: recent.length >= 3 && avgGapMs < 20_000,
    isRapidDialogue,
    isContinuation,
  };
};

export type VelocityDecision = 'proceed' | 'wait' | 'skip';

export const decideFromVelocity = (snap: VelocitySnapshot, isGroup: boolean): VelocityDecision => {
  if (snap.isContinuation) return 'wait';

  if (isGroup) {
    if (snap.isRapidDialogue) return 'skip';
    if (snap.isBurst) return 'wait';
  }

  return 'proceed';
};
