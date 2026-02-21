export interface AnthropicThinkingOptions {
  type: 'adaptive' | 'enabled';
  budgetTokens?: number;
}

export const getAnthropicThinking = (
  modelId: string,
  role: 'default' | 'fast',
): AnthropicThinkingOptions | null => {
  if (role !== 'default') return null;

  const id = modelId.toLowerCase();

  if (id.includes('opus')) return { type: 'adaptive' };
  if (id.includes('sonnet')) return { type: 'enabled', budgetTokens: 1024 };

  return null;
};
