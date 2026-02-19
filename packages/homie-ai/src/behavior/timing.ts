import type { HomieBehaviorSleepConfig } from '../config/types.js';

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export const parseHHMM = (hhmm: string): { h: number; m: number } => {
  const m = /^(\d{2}):(\d{2})$/u.exec(hhmm);
  if (!m) throw new Error(`Invalid time: ${hhmm}`);
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) throw new Error(`Invalid time: ${hhmm}`);
  return { h, m: mm };
};

export const isInSleepWindow = (now: Date, sleep: HomieBehaviorSleepConfig): boolean => {
  if (!sleep.enabled) return false;

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: sleep.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const nowMinutes = hour * 60 + minute;

  const start = parseHHMM(sleep.startLocal);
  const end = parseHHMM(sleep.endLocal);
  const startMinutes = start.h * 60 + start.m;
  const endMinutes = end.h * 60 + end.m;

  // Window can cross midnight.
  if (startMinutes <= endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
};

export const randomDelayMs = (minMs: number, maxMs: number): number => {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(lo, Math.max(minMs, maxMs));
  return Math.floor(lo + Math.random() * (hi - lo + 1));
};

const sampleStandardNormal = (rng: () => number): number => {
  // Box–Muller transform.
  // Guard against log(0) from pathological RNGs.
  const u1 = clamp(rng(), Number.EPSILON, 1 - Number.EPSILON);
  const u2 = clamp(rng(), Number.EPSILON, 1 - Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

export type HumanDelayKind = 'send_text' | 'react';

export interface HumanDelayOptions {
  readonly minMs: number;
  readonly maxMs: number;
  readonly kind: HumanDelayKind;
  /** Approx reply length (chars). Used to bias longer replies slower. */
  readonly textLen: number;
  /** Optional: if incoming looks like a direct question, bias faster. */
  readonly isQuestion?: boolean | undefined;
  /** Injected RNG for tests. Defaults to Math.random. */
  readonly rng?: (() => number) | undefined;
}

/**
 * Sample a human-like delay using a bounded log-normal distribution.
 *
 * - `minMs` / `maxMs` are hard bounds.
 * - Median increases with `textLen` (longer replies => longer pauses).
 * - Direct questions bias faster.
 */
export const sampleHumanDelayMs = (opts: HumanDelayOptions): number => {
  const minMs = Math.max(0, Math.floor(opts.minMs));
  const maxMs = Math.max(minMs, Math.floor(opts.maxMs));
  if (maxMs <= 0) return 0;
  if (minMs === maxMs) return minMs;

  // Keep the distribution well-defined even if min=0.
  const lo = Math.max(1, minMs);
  const hi = Math.max(lo + 1, maxMs);

  // Bias the median based on the amount of text we're about to send.
  const len = Math.max(0, Math.floor(opts.textLen));
  const lenScale = clamp(len / 240, 0, 1); // 0 for tiny replies, ~1 for "full" replies
  let median = lo + (hi - lo) * (0.2 + 0.65 * lenScale);
  if (opts.kind === 'react') median = lo + (hi - lo) * 0.12;
  if (opts.isQuestion) median *= 0.85;

  median = clamp(median, lo, hi);

  // Choose sigma so that (roughly) p10~lo and p90~hi for the default range.
  // z0.90 ~= 1.2815515655
  const z = 1.2815515655446004;
  const sigma = clamp(Math.log(hi / lo) / (2 * z), 0.15, 1.2);
  const mu = Math.log(median);

  const rng = opts.rng ?? Math.random;
  const z0 = sampleStandardNormal(rng);
  const sample = Math.exp(mu + sigma * z0);
  const bounded = clamp(sample, lo, hi);

  // Re-apply the exact user-requested bounds (including allowing 0).
  return clamp(Math.floor(bounded), minMs, maxMs);
};
