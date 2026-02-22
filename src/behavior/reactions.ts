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

export const NEVER_USE = new Set(['😂', '👍', '💩', '🤗', '👏']);

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function pickWeightedReaction(pool: readonly ReactionEntry[], rng01: number): string {
  if (pool.length === 0) return '💀';

  let total = 0;
  for (const e of pool) total += e.weight > 0 ? e.weight : 0;
  if (total <= 0) return pool[0]?.emoji ?? '💀';

  const r = clamp01(rng01) * total;
  let acc = 0;
  for (const e of pool) {
    if (e.weight <= 0) continue;
    acc += e.weight;
    if (r <= acc) return e.emoji;
  }
  return pool.at(-1)?.emoji ?? '💀';
}
