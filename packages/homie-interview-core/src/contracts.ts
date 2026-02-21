export interface InterviewModelClient {
  complete(params: {
    role: 'fast' | 'default';
    system: string;
    user: string;
    onReasoningDelta?: ((delta: string) => void) | undefined;
  }): Promise<string>;
}
