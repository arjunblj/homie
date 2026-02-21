import { describe, expect, test } from 'bun:test';
import type { CompleteParams, CompletionResult, LLMBackend } from '../backend/types.js';
import { BackendAdapter } from './backendAdapter.js';

describe('BackendAdapter', () => {
  test('forwards onReasoningDelta through backend stream observer', async () => {
    const seen: string[] = [];
    const backend: LLMBackend = {
      complete: async (params: CompleteParams): Promise<CompletionResult> => {
        params.stream?.onReasoningDelta?.('trace chunk');
        return { text: 'ok', steps: [{ type: 'llm', text: 'ok' }] };
      },
    };

    const adapter = new BackendAdapter(backend);
    const text = await adapter.complete({
      role: 'fast',
      system: 's',
      user: 'u',
      onReasoningDelta: (delta) => seen.push(delta),
    });

    expect(text).toBe('ok');
    expect(seen).toEqual(['trace chunk']);
  });

  test('calls backend with correct params', async () => {
    let captured: CompleteParams | null = null;
    const mockBackend: LLMBackend = {
      complete: async (params) => {
        captured = params;
        return { text: 'response', steps: [] };
      },
    };

    const adapter = new BackendAdapter(mockBackend);
    const res = await adapter.complete({ role: 'fast', system: 'SYS', user: 'USR' });

    expect(res).toBe('response');
    expect(captured).not.toBeNull();
    const c = captured as unknown as CompleteParams;
    expect(c.role).toBe('fast');
    expect(c.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USR' },
    ]);
  });

  test('uses backend completeObject when available', async () => {
    const backend: LLMBackend = {
      complete: async () => ({ text: 'unused', steps: [] }),
      completeObject: async <T>() => ({
        output: { done: true, question: '' } as unknown as T,
      }),
    };
    const adapter = new BackendAdapter(backend);
    const out = await adapter.completeObject<{ done: boolean; question: string }>({
      role: 'fast',
      system: 'SYS',
      user: 'USR',
      schema: {},
    });
    expect(out.done).toBeTrue();
  });

  test('falls back to JSON extraction when completeObject is unavailable', async () => {
    const backend: LLMBackend = {
      complete: async () => ({ text: '{"done":false,"question":"q"}', steps: [] }),
    };
    const adapter = new BackendAdapter(backend);
    const out = await adapter.completeObject<{ done: boolean; question: string }>({
      role: 'fast',
      system: 'SYS',
      user: 'USR',
      schema: {},
    });
    expect(out).toEqual({ done: false, question: 'q' });
  });
});
