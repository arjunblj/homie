import { useCallback, useState } from 'react';

import { addUsage, EMPTY_USAGE } from './format.js';
import type { UsageSummary } from './types.js';

export interface SessionUsageTracker {
  readonly usage: UsageSummary;
  readonly llmCalls: number;
  addTurnUsage(turnUsage: UsageSummary, turnLlmCalls: number): void;
  reset(): void;
}

export const accumulateLlmCalls = (current: number, increment: number): number =>
  current + increment;

export const useSessionUsage = (): SessionUsageTracker => {
  const [usage, setUsage] = useState<UsageSummary>(EMPTY_USAGE);
  const [llmCalls, setLlmCalls] = useState(0);

  const addTurnUsage = useCallback((turnUsage: UsageSummary, turnLlmCalls: number): void => {
    setUsage((prev) => addUsage(prev, turnUsage));
    setLlmCalls((prev) => accumulateLlmCalls(prev, turnLlmCalls));
  }, []);

  const reset = useCallback((): void => {
    setUsage(EMPTY_USAGE);
    setLlmCalls(0);
  }, []);

  return { usage, llmCalls, addTurnUsage, reset };
};
