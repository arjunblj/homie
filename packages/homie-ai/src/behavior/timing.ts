import type { HomieBehaviorSleepConfig } from '../config/types.js';

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
