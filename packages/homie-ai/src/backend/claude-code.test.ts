import { describe, expect, test } from 'bun:test';
import { ClaudeCodeBackend } from './claude-code.js';
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

describe('ClaudeCodeBackend', () => {
  test('parses JSON output response', async () => {
    const backend = new ClaudeCodeBackend({
      execImpl: async () => ok(JSON.stringify({ result: 'hi there' })),
    });
    const out = await backend.complete(baseParams);
    expect(out.text).toBe('hi there');
    expect(out.modelId).toBe('opus');
  });

  test('pipes prompt via stdin and uses --append-system-prompt', async () => {
    let receivedStdin = '';
    let receivedArgs: string[] = [];
    const backend = new ClaudeCodeBackend({
      execImpl: async (args, _timeouts, stdinData) => {
        receivedStdin = stdinData ?? '';
        receivedArgs = args;
        return ok(JSON.stringify({ result: 'ok' }));
      },
    });
    await backend.complete(baseParams);
    expect(receivedStdin).toContain('Say hi');
    expect(receivedStdin).not.toContain('You are concise');
    expect(receivedArgs).toContain('--append-system-prompt');
  });

  test('throws on non-zero exit', async () => {
    const backend = new ClaudeCodeBackend({
      execImpl: async () => ({
        code: 1,
        stdout: '',
        stderr: 'not logged in',
        timedOut: false,
      }),
    });
    await expect(backend.complete(baseParams)).rejects.toThrow('claude failed');
  });

  test('throws actionable error on first-byte timeout', async () => {
    const backend = new ClaudeCodeBackend({
      execImpl: async () => ({
        code: 1,
        stdout: '',
        stderr: '',
        timedOut: 'first-byte' as const,
      }),
    });
    await expect(backend.complete(baseParams)).rejects.toThrow('first-byte timeout');
  });

  test('fires observer callbacks in real-time during streaming', async () => {
    const deltas: string[] = [];
    const backend = new ClaudeCodeBackend({
      execImpl: async (_args, _timeouts, _stdin, onChunk) => {
        const lines = [
          JSON.stringify({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'hello ' },
            },
          }),
          JSON.stringify({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'world' },
            },
          }),
          JSON.stringify({ type: 'result', result: 'hello world' }),
        ];
        for (const line of lines) onChunk?.(`${line}\n`);
        return ok(lines.join('\n'));
      },
    });
    const out = await backend.complete({
      ...baseParams,
      stream: { onTextDelta: (d) => deltas.push(d) },
    });
    expect(out.text).toBe('hello world');
    expect(deltas).toEqual(['hello ', 'world']);
  });

  test('throws when streaming result includes is_error', async () => {
    const backend = new ClaudeCodeBackend({
      execImpl: async (_args, _timeouts, _stdin, onChunk) => {
        onChunk?.(
          `${JSON.stringify({ type: 'result', is_error: true, error: 'payment failed' })}\n`,
        );
        return ok('');
      },
    });
    await expect(
      backend.complete({
        ...baseParams,
        stream: { onTextDelta: () => {} },
      }),
    ).rejects.toThrow('payment failed');
  });

  test('forwards cancellation signal to exec implementation', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const backend = new ClaudeCodeBackend({
      execImpl: async (_args, _timeouts, _stdin, _onChunk, signal) => {
        seenSignal = signal;
        return ok(JSON.stringify({ result: 'ok' }));
      },
    });
    await backend.complete({ ...baseParams, signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });
});
