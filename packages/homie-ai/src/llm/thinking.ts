export interface AnthropicThinkingOptions {
  type: 'adaptive' | 'enabled';
  budgetTokens?: number;
}

export const getAnthropicThinking = (
  modelId: string,
  role: 'default' | 'fast',
): AnthropicThinkingOptions | null => {
  // Keep fast/extraction models cheap + deterministic by default.
  if (role !== 'default') return null;

  const id = modelId.toLowerCase();

  // Opus gets adaptive thinking by default
  if (id.includes('opus')) return { type: 'adaptive' };

  // Sonnet/others: enable with a modest budget (tunable later via config).
  if (id.includes('sonnet')) return { type: 'enabled', budgetTokens: 1024 };

  return null;
};
