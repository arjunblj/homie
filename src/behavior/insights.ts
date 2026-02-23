import type { OpenhomieConfig } from '../config/types.js';
import type { LessonType } from '../memory/types.js';
import type { SessionMessage } from '../session/types.js';
import { checkSlop } from './slop.js';
import { isInSleepWindow } from './timing.js';

export type BehaviorInsightKey =
  | 'sleep_window_violation'
  | 'assistant_rapid_fire'
  | 'group_rapid_dialogue'
  | 'slop_pattern_frequency';

export interface BehaviorInsight {
  readonly key: BehaviorInsightKey;
  readonly type: LessonType;
  readonly rule: string;
  readonly content: string;
  readonly confidence: number;
}

const DAY_MS = 86_400_000;

const normalizeOneLine = (raw: string): string =>
  raw
    .replace(/\s*\n+\s*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

const isReactionMessage = (text: string): boolean => text.trimStart().startsWith('[REACTION]');

const avgGapMs = (timestamps: number[]): number => {
  const ts = timestamps.slice().sort((a, b) => a - b);
  if (ts.length < 2) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 1; i < ts.length; i += 1) sum += (ts[i] ?? 0) - (ts[i - 1] ?? 0);
  return sum / (ts.length - 1);
};

export function deriveBehaviorInsights(opts: {
  readonly config: OpenhomieConfig;
  readonly isGroup: boolean;
  readonly messages: readonly SessionMessage[];
  readonly nowMs?: number | undefined;
}): BehaviorInsight[] {
  const nowMs = opts.nowMs ?? Date.now();
  const msgs24h = opts.messages.filter((m) => (m.createdAtMs ?? 0) >= nowMs - DAY_MS);

  const insights: BehaviorInsight[] = [];

  // 1) Sleep window violations: assistant sends inside configured sleep window.
  {
    const assistant = msgs24h.filter(
      (m) => m.role === 'assistant' && !isReactionMessage(m.content),
    );
    const violating = assistant.filter((m) =>
      isInSleepWindow(new Date(m.createdAtMs), opts.config.behavior.sleep),
    );
    if (violating.length > 0) {
      const sleep = opts.config.behavior.sleep;
      const count = violating.length;
      const confidence = clamp01(0.65 + Math.min(0.25, 0.05 * count));
      insights.push({
        key: 'sleep_window_violation',
        type: 'pattern',
        rule: `Avoid sending messages during sleep window (${sleep.startLocal}-${sleep.endLocal} ${sleep.timezone}) unless urgent.`,
        content: `Observed ${count} assistant message(s) sent during the configured sleep window in the last 24h.`,
        confidence,
      });
    }
  }

  // 2) Assistant rapid-fire: multiple assistant messages sent in quick succession.
  {
    const assistant = msgs24h
      .filter((m) => m.role === 'assistant' && !isReactionMessage(m.content))
      .map((m) => m.createdAtMs)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      .sort((a, b) => a - b);

    let rapidGaps = 0;
    let tightestGapMs = Number.POSITIVE_INFINITY;
    for (let i = 1; i < assistant.length; i += 1) {
      const gap = (assistant[i] ?? 0) - (assistant[i - 1] ?? 0);
      if (gap > 0 && gap <= 6_000) {
        rapidGaps += 1;
        tightestGapMs = Math.min(tightestGapMs, gap);
      }
    }

    if (rapidGaps >= 2) {
      const confidence = clamp01(0.6 + Math.min(0.25, 0.06 * rapidGaps));
      insights.push({
        key: 'assistant_rapid_fire',
        type: 'pattern',
        rule: 'Avoid multi-message bursts; batch thoughts into one message when possible.',
        content: `Observed rapid-fire assistant sends: ${rapidGaps} gap(s) <= 6s in the last 24h (tightest gap ~${Math.round(
          tightestGapMs / 1000,
        )}s).`,
        confidence,
      });
    }
  }

  // 3) Group rapid dialogue environment: when the room is in a high-velocity back-and-forth.
  if (opts.isGroup) {
    const windowMs = 10 * 60_000;
    const cutoff = nowMs - windowMs;
    const recent = msgs24h.filter((m) => m.role === 'user' && (m.createdAtMs ?? 0) >= cutoff);
    if (recent.length >= 6) {
      const timestamps = recent
        .map((m) => m.createdAtMs)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      const uniqueAuthors = new Set(recent.map((m) => m.authorId).filter(Boolean));
      const gap = avgGapMs(timestamps);
      if (uniqueAuthors.size >= 2 && gap < 15_000) {
        const confidence = clamp01(0.62 + Math.min(0.22, (15_000 - gap) / 60_000));
        insights.push({
          key: 'group_rapid_dialogue',
          type: 'pattern',
          rule: 'In rapid group back-and-forth, prefer reactions or silence; wait for a lull to reply.',
          content: `Group looked high-velocity: ${recent.length} user message(s) in last 10m; avg gap ~${Math.round(
            gap / 1000,
          )}s across ${uniqueAuthors.size} author(s).`,
          confidence,
        });
      }
    }
  }

  // 4) Slop pattern frequency: detect repeated slop categories across recent assistant outputs.
  {
    const assistant = msgs24h
      .filter((m) => m.role === 'assistant' && !isReactionMessage(m.content))
      .slice(-12)
      .map((m) => normalizeOneLine(m.content))
      .filter(Boolean);
    if (assistant.length >= 3) {
      const categoryCounts = new Map<string, number>();
      let slopMessages = 0;
      let checked = 0;
      for (const text of assistant) {
        checked += 1;
        const r = checkSlop(text);
        if (r.isSlop) slopMessages += 1;
        for (const v of r.violations) {
          categoryCounts.set(v.category, (categoryCounts.get(v.category) ?? 0) + 1);
        }
      }

      const ranked = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);
      const top = ranked.slice(0, 3).filter(([, c]) => c >= 2);
      const topCount = top[0]?.[1] ?? 0;

      if (slopMessages >= 2 || topCount >= 4) {
        const topStr = top.map(([c, n]) => `${c} (${n})`).join(', ');
        const confidence = clamp01(0.55 + 0.08 * slopMessages + 0.03 * topCount);
        insights.push({
          key: 'slop_pattern_frequency',
          type: 'pattern',
          rule: top.length
            ? `Avoid slop patterns (${top.map(([c]) => c).join(', ')}); lead with substance and concrete next step.`
            : 'Avoid slop patterns; lead with substance and concrete next step.',
          content: topStr
            ? `Slop violations detected in ${slopMessages}/${checked} recent assistant message(s). Top categories: ${topStr}.`
            : `Slop violations detected in ${slopMessages}/${checked} recent assistant message(s).`,
          confidence,
        });
      }
    }
  }

  return insights;
}
