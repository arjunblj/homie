export const estimateTokens = (text: string): number => {
  // Cheap heuristic: ~4 chars/token for English-ish text.
  // Later: replace with provider tokenizer if/when needed.
  return Math.ceil(text.length / 4);
};

export const truncateToTokenBudget = (text: string, maxTokens: number): string => {
  if (maxTokens <= 0) return '';
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n\n[...truncated]`;
};
