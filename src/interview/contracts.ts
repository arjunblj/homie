export interface InterviewUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  costUsd?: number | undefined;
  txHash?: string | undefined;
}

export interface InterviewModelClient {
  complete(params: {
    role: 'fast' | 'default';
    system: string;
    user: string;
    onReasoningDelta?: ((delta: string) => void) | undefined;
    onUsage?: ((usage: InterviewUsage) => void) | undefined;
  }): Promise<string>;
  completeObject?<T>(params: {
    role: 'fast' | 'default';
    system: string;
    user: string;
    schema: unknown;
    onReasoningDelta?: ((delta: string) => void) | undefined;
    onUsage?: ((usage: InterviewUsage) => void) | undefined;
  }): Promise<T>;
}
