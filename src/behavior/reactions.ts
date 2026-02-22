export interface ReactionEntry {
  emoji: string;
  weight: number;
}

export const DEFAULT_REACTION_POOL: readonly ReactionEntry[] = [
  { emoji: '💀', weight: 25 },
  { emoji: '😭', weight: 20 },
  { emoji: '🔥', weight: 20 },
  { emoji: '❤️', weight: 10 },
  { emoji: '👀', weight: 10 },
  { emoji: '💯', weight: 8 },
  { emoji: '🫡', weight: 5 },
  { emoji: '🗿', weight: 2 },
];

export const NEVER_USE: ReadonlySet<string> = new Set(['😂', '👍', '💩', '🤗', '👏']);

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function pickWeightedReaction(pool: readonly ReactionEntry[], rng01: number): string {
  if (pool.length === 0) return '💀';

  let total = 0;
  let fallback: string | undefined;
  for (const e of pool) {
    if (e.weight <= 0) continue;
    if (NEVER_USE.has(e.emoji)) continue;
    total += e.weight;
    fallback = e.emoji;
  }
  if (total <= 0) return fallback ?? pool[0]?.emoji ?? '💀';

  const r = clamp01(rng01) * total;
  let acc = 0;
  for (const e of pool) {
    if (e.weight <= 0) continue;
    if (NEVER_USE.has(e.emoji)) continue;
    acc += e.weight;
    if (r <= acc) return e.emoji;
  }
  return fallback ?? pool.at(-1)?.emoji ?? '💀';
}
