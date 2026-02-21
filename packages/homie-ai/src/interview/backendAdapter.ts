import {
  extractJsonObject,
  type InterviewModelClient,
  type InterviewUsage,
} from 'homie-interview-core';
import type { LLMBackend } from '../backend/types.js';

export class BackendAdapter implements InterviewModelClient {
  constructor(private readonly backend: LLMBackend) {}

  async complete(params: {
    role: 'fast' | 'default';
    system: string;
    user: string;
    onReasoningDelta?: ((delta: string) => void) | undefined;
    onUsage?: ((usage: InterviewUsage) => void) | undefined;
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
    if (res.usage) params.onUsage?.(res.usage);
    return res.text;
  }

  async completeObject<T>(params: {
    role: 'fast' | 'default';
    system: string;
    user: string;
    schema: unknown;
    onReasoningDelta?: ((delta: string) => void) | undefined;
    onUsage?: ((usage: InterviewUsage) => void) | undefined;
  }): Promise<T> {
    if (this.backend.completeObject) {
      const res = await this.backend.completeObject<T>({
        role: params.role,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
        schema: params.schema,
      });
      if (res.usage) params.onUsage?.(res.usage);
      return res.output;
    }
    const text = await this.complete({
      role: params.role,
      system: params.system,
      user: params.user,
      ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
      ...(params.onUsage ? { onUsage: params.onUsage } : {}),
    });
    return extractJsonObject(text) as T;
  }
}
