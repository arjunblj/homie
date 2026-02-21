import { describe, expect, test } from 'bun:test';
import { CodexCliBackend } from './codex-cli.js';
import type { SpawnResult } from './spawn.js';
import type { CompleteParams } from './types.js';

const ok = (stdout: string): SpawnResult => ({
  code: 0,
  stdout,
  stderr: '',
  timedOut: false,
});

const baseParams: CompleteParams = {
  role: 'default',
  maxSteps: 1,
  messages: [
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: 'Say hi' },
  ],
};

describe('CodexCliBackend', () => {
  test('extracts agent_message text from jsonl stream', async () => {
    const backend = new CodexCliBackend({
      retryAttempts: 0,
      execImpl: async () =>
        ok(
          JSON.stringify({
            type: 'item.completed',
            item: { id: 'm1', type: 'agent_message', text: 'hello world' },
          }),
        ),
    });
    const out = await backend.complete(baseParams);
    expect(out.text).toBe('hello world');
    expect(out.modelId).toBe('gpt-5.3-codex');
  });

  test('falls back to codex default when configured model is blank', async () => {
    let seenArgs: string[] = [];
    const backend = new CodexCliBackend({
      defaultModel: '',
      fastModel: '',
      retryAttempts: 0,
      execImpl: async (args) => {
        seenArgs = args;
        return ok(
          JSON.stringify({
            type: 'item.completed',
            item: { id: 'm1', type: 'agent_message', text: 'default model reply' },
          }),
        );
      },
    });
    const out = await backend.complete(baseParams);
    expect(out.text).toBe('default model reply');
    expect(out.modelId).toBe('codex-default');
    expect(seenArgs.includes('--model')).toBeFalse();
  });

  test('throws on non-zero exit', async () => {
    const backend = new CodexCliBackend({
      retryAttempts: 0,
      execImpl: async () => ({
        code: 1,
        stdout: '',
        stderr: 'auth required',
        timedOut: false,
      }),
    });
    await expect(backend.complete(baseParams)).rejects.toThrow('codex failed');
  });

  test('falls back to codex-default when model unavailable', async () => {
    let calls = 0;
    const backend = new CodexCliBackend({
      retryAttempts: 0,
      execImpl: async (args) => {
        calls += 1;
        if (args.includes('gpt-5.3-codex')) {
          return {
            code: 1,
            stdout: '',
            stderr: 'The model `gpt-5.3-codex` does not exist or you do not have access',
            timedOut: false,
          };
        }
        return ok(
          JSON.stringify({
            type: 'item.completed',
            item: { id: 'm1', type: 'agent_message', text: 'fallback' },
          }),
        );
      },
    });
    const out = await backend.complete(baseParams);
    expect(out.text).toBe('fallback');
    expect(out.modelId).toBe('codex-default');
    expect(calls).toBe(2);
  });

  test('throws actionable error on first-byte timeout', async () => {
    const backend = new CodexCliBackend({
      retryAttempts: 0,
      execImpl: async () => ({
        code: 1,
        stdout: '',
        stderr: '',
        timedOut: 'first-byte' as const,
      }),
    });
    await expect(backend.complete(baseParams)).rejects.toThrow('first-byte timeout');
  });

  test('does not retry after streaming output to avoid duplicate deltas', async () => {
    let calls = 0;
    const backend = new CodexCliBackend({
      retryAttempts: 1,
      execImpl: async (_args, _timeouts, onChunk) => {
        calls += 1;
        if (calls === 1) {
          onChunk?.(
            `${JSON.stringify({
              type: 'item.completed',
              item: { id: 'm1', type: 'agent_message', text: 'first-attempt' },
            })}\n`,
          );
          return {
            code: 1,
            stdout: '',
            stderr: 'network timeout',
            timedOut: false,
          };
        }
        return {
          code: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      },
    });
    await expect(
      backend.complete({
        ...baseParams,
        stream: { onTextDelta: () => {} },
      }),
    ).rejects.toThrow('codex failed');
    expect(calls).toBe(1);
  });

  test('flushes trailing stream buffer without newline', async () => {
    const backend = new CodexCliBackend({
      retryAttempts: 0,
      execImpl: async (_args, _timeouts, onChunk) => {
        onChunk?.(
          JSON.stringify({
            type: 'item.completed',
            item: { id: 'm1', type: 'agent_message', text: 'tail flush' },
          }),
        );
        return ok('');
      },
    });
    const out = await backend.complete({
      ...baseParams,
      stream: { onTextDelta: () => {} },
    });
    expect(out.text).toBe('tail flush');
  });

  test('forwards cancellation signal to exec implementation', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const backend = new CodexCliBackend({
      retryAttempts: 0,
      execImpl: async (_args, _timeouts, _onChunk, signal) => {
        seenSignal = signal;
        return ok(
          JSON.stringify({
            type: 'item.completed',
            item: { id: 'm1', type: 'agent_message', text: 'ok' },
          }),
        );
      },
    });
    await backend.complete({ ...baseParams, signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });
});
