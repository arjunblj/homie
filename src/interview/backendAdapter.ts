import type { LLMBackend } from '../backend/types.js';
import type { InterviewModelClient } from './contracts.js';

export class BackendAdapter implements InterviewModelClient {
  constructor(private readonly backend: LLMBackend) {}

  async complete(params: {
    role: 'fast' | 'default';
    system: string;
    user: string;
    onReasoningDelta?: ((delta: string) => void) | undefined;
  }): Promise<string> {
    const res = await this.backend.complete({
      role: params.role,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      maxSteps: 1,
      ...(params.onReasoningDelta
        ? {
            stream: {
              onReasoningDelta: params.onReasoningDelta,
            },
          }
        : {}),
    });
    return res.text;
  }
}
