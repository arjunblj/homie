export const estimateTokens = (text: string): number => {
  // Claude-family models tend to use fewer chars/token than GPT-style tokenizers.
  // We use a calibrated heuristic for budgeting/compaction decisions (not exact counting).
  return Math.ceil(text.length / 3.3);
};

export const truncateToTokenBudget = (text: string, maxTokens: number): string => {
  if (maxTokens <= 0) return '';
  const maxChars = Math.floor(maxTokens * 3.3);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n\n[...truncated]`;
};
