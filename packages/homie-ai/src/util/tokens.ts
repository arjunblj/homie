export const estimateTokens = (text: string): number => {
  return Math.ceil(text.length / 4);
};

export const truncateToTokenBudget = (text: string, maxTokens: number): string => {
  if (maxTokens <= 0) return '';
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n\n[...truncated]`;
};
