import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { ChatTurnStream } from '../cli/ink/types.js';
import type { OutgoingAction } from '../engine/types.js';
import { createCliTurnHandler } from './cli-turn.js';

const collectEvents = async (
  stream: ChatTurnStream,
): Promise<Array<{ type: string; value: unknown }>> => {
  const out: Array<{ type: string; value: unknown }> = [];
  for await (const event of stream.events) {
    out.push({ type: event.type, value: event });
  }
  return out;
};

describe('createCliTurnHandler', () => {
  test('maps send_text responses and forwards operator message metadata', async () => {
    const seen: IncomingMessage[] = [];
    const engine = {
      handleIncomingMessage: async (msg: IncomingMessage): Promise<OutgoingAction> => {
        seen.push(msg);
        return { kind: 'send_text', text: `echo:${msg.text}` };
      },
    };

    const turn = createCliTurnHandler(engine);
    const stream = turn({ text: 'hello' });
    const events = await collectEvents(stream);

    expect(events.at(-1)?.type).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.channel).toBe('cli');
    expect(seen[0]?.authorId).toBe('operator');
    expect(seen[0]?.isOperator).toBeTrue();
    expect(String(seen[0]?.chatId)).toBe('cli:local');
    expect(String(seen[0]?.messageId)).toBe('cli:1');
  });

  test('maps react responses', async () => {
    const engine = {
      handleIncomingMessage: async (_msg: IncomingMessage): Promise<OutgoingAction> => ({
        kind: 'react',
        emoji: '🔥',
        targetAuthorId: 'operator',
        targetTimestampMs: Date.now(),
      }),
    };

    const turn = createCliTurnHandler(engine);
    const stream = turn({ text: 'ship it' });
    const events = await collectEvents(stream);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('maps silence responses and preserves reason when present', async () => {
    const engine = {
      handleIncomingMessage: async (_msg: IncomingMessage): Promise<OutgoingAction> => ({
        kind: 'silence',
        reason: 'engagement_gate',
      }),
    };

    const turn = createCliTurnHandler(engine);
    const stream = turn({ text: '...' });
    const events = await collectEvents(stream);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('maps silence responses with fallback reason', async () => {
    const engine = {
      handleIncomingMessage: async (_msg: IncomingMessage): Promise<OutgoingAction> => ({
        kind: 'silence',
      }),
    };

    const turn = createCliTurnHandler(engine);
    const stream = turn({ text: '...' });
    const events = await collectEvents(stream);
    const last = events.at(-1)?.value as
      | { type?: string; result?: { kind?: string; reason?: string } }
      | undefined;
    expect(last?.type).toBe('done');
    expect(last?.result?.kind).toBe('silence');
    expect(last?.result?.reason).toBe('no_reply');
  });

  test('increments message ids across turns', async () => {
    const seenIds: string[] = [];
    const engine = {
      handleIncomingMessage: async (msg: IncomingMessage): Promise<OutgoingAction> => {
        seenIds.push(String(msg.messageId));
        return { kind: 'silence' };
      },
    };

    const turn = createCliTurnHandler(engine);
    for await (const _event of turn({ text: 'one' }).events) {
      // drain
    }
    for await (const _event of turn({ text: 'two' }).events) {
      // drain
    }
    for await (const _event of turn({ text: 'three' }).events) {
      // drain
    }

    expect(seenIds).toEqual(['cli:1', 'cli:2', 'cli:3']);
  });

  test('forwards streaming observer events before done', async () => {
    const engine = {
      handleIncomingMessage: async (
        _msg: IncomingMessage,
        observer?: {
          onPhase?: ((phase: 'thinking' | 'streaming' | 'tool_use') => void) | undefined;
          onTextDelta?: ((delta: string) => void) | undefined;
          onReasoningDelta?: ((delta: string) => void) | undefined;
          onToolCall?:
            | ((event: { toolCallId: string; toolName: string; input?: unknown }) => void)
            | undefined;
          onToolResult?:
            | ((event: { toolCallId: string; toolName: string; output?: unknown }) => void)
            | undefined;
        },
      ): Promise<OutgoingAction> => {
        observer?.onPhase?.('thinking');
        observer?.onReasoningDelta?.('analyzing request');
        observer?.onTextDelta?.('hello');
        observer?.onToolCall?.({ toolCallId: 't1', toolName: 'read_url', input: { url: 'x' } });
        observer?.onToolResult?.({ toolCallId: 't1', toolName: 'read_url', output: { ok: true } });
        observer?.onTextDelta?.(' world');
        return { kind: 'send_text', text: 'hello world' };
      },
    };

    const turn = createCliTurnHandler(engine);
    const events = await collectEvents(turn({ text: 'stream' }));
    const types = events.map((e) => e.type);
    expect(types).toContain('phase');
    expect(types).toContain('reasoning_delta');
    expect(types).toContain('text_delta');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types.at(-1)).toBe('done');
  });

  test('forwards usage summaries before done', async () => {
    const engine = {
      handleIncomingMessage: async (
        _msg: IncomingMessage,
        observer?: {
          onUsage?:
            | ((event: {
                llmCalls: number;
                modelId?: string | undefined;
                usage: {
                  inputTokens: number;
                  outputTokens: number;
                  cacheReadTokens: number;
                  cacheWriteTokens: number;
                  reasoningTokens: number;
                  costUsd: number;
                };
              }) => void)
            | undefined;
        },
      ): Promise<OutgoingAction> => {
        observer?.onUsage?.({
          llmCalls: 2,
          modelId: 'openai/gpt-4o-mini',
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            costUsd: 0.0012,
          },
        });
        return { kind: 'send_text', text: 'ok' };
      },
    };

    const turn = createCliTurnHandler(engine);
    const events = await collectEvents(turn({ text: 'usage' }));
    const usageEvent = events.find((event) => event.type === 'usage')?.value as
      | {
          type?: string;
          summary?: { llmCalls?: number; usage?: { inputTokens?: number; costUsd?: number } };
        }
      | undefined;
    expect(usageEvent?.type).toBe('usage');
    expect(usageEvent?.summary?.llmCalls).toBe(2);
    expect(usageEvent?.summary?.usage?.inputTokens).toBe(12);
    expect(usageEvent?.summary?.usage?.costUsd).toBe(0.0012);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('forwards usage tx hash for payment receipts', async () => {
    const txHash = `0x${'c'.repeat(64)}`;
    const engine = {
      handleIncomingMessage: async (
        _msg: IncomingMessage,
        observer?: {
          onUsage?:
            | ((event: {
                llmCalls: number;
                modelId?: string | undefined;
                txHash?: string | undefined;
                usage: {
                  inputTokens: number;
                  outputTokens: number;
                  cacheReadTokens: number;
                  cacheWriteTokens: number;
                  reasoningTokens: number;
                  costUsd: number;
                };
              }) => void)
            | undefined;
        },
      ): Promise<OutgoingAction> => {
        observer?.onUsage?.({
          llmCalls: 1,
          txHash,
          usage: {
            inputTokens: 5,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            costUsd: 0.0042,
          },
        });
        return { kind: 'send_text', text: 'ok' };
      },
    };

    const events = await collectEvents(createCliTurnHandler(engine)({ text: 'usage tx' }));
    const usageEvent = events.find((event) => event.type === 'usage')?.value as
      | {
          type?: string;
          summary?: { txHash?: string; llmCalls?: number };
        }
      | undefined;
    expect(usageEvent?.type).toBe('usage');
    expect(usageEvent?.summary?.llmCalls).toBe(1);
    expect(usageEvent?.summary?.txHash).toBe(txHash);
  });

  test('coalesces rapid delta events into batched frames', async () => {
    const engine = {
      handleIncomingMessage: async (
        _msg: IncomingMessage,
        observer?: {
          onTextDelta?: ((delta: string) => void) | undefined;
          onReasoningDelta?: ((delta: string) => void) | undefined;
        },
      ): Promise<OutgoingAction> => {
        observer?.onTextDelta?.('hel');
        observer?.onTextDelta?.('lo');
        observer?.onReasoningDelta?.('think ');
        observer?.onReasoningDelta?.('fast');
        return { kind: 'send_text', text: 'hello' };
      },
    };

    const start = createCliTurnHandler(engine, { deltaBatchMs: 50 });
    const events = await collectEvents(start({ text: 'batch me' }));
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    const reasoningDeltas = events.filter((e) => e.type === 'reasoning_delta');
    expect(textDeltas).toHaveLength(1);
    expect(reasoningDeltas).toHaveLength(1);
    expect((textDeltas[0]?.value as { text?: string } | undefined)?.text).toBe('hello');
    expect((reasoningDeltas[0]?.value as { text?: string } | undefined)?.text).toBe('think fast');
  });

  test('cancel emits interrupted done result', async () => {
    const engine = {
      handleIncomingMessage: async (
        _msg: IncomingMessage,
        _observer?: unknown,
        opts?: { signal?: AbortSignal },
      ): Promise<OutgoingAction> => {
        return await new Promise<OutgoingAction>((resolve, reject) => {
          const t = setTimeout(() => resolve({ kind: 'send_text', text: 'late' }), 50);
          opts?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      },
    };

    const start = createCliTurnHandler(engine);
    const stream = start({ text: 'cancel me' });
    stream.cancel();
    const events = await collectEvents(stream);
    const last = events.at(-1)?.value as
      | { type?: string; result?: { reason?: string } }
      | undefined;
    expect(last?.type).toBe('done');
    expect(last?.result?.reason).toBe('interrupted');
  });

  test('loads local file attachment and passes metadata/getBytes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'homie-cli-turn-'));
    const filePath = path.join(dir, 'note.txt');
    await writeFile(filePath, 'hello attachment', 'utf8');
    try {
      let seenFileName = '';
      let seenBytes: Uint8Array | undefined;
      const engine = {
        handleIncomingMessage: async (msg: IncomingMessage): Promise<OutgoingAction> => {
          const first = msg.attachments?.[0];
          seenFileName = first?.fileName ?? '';
          seenBytes = await first?.getBytes?.();
          return { kind: 'send_text', text: 'ok' };
        },
      };
      const start = createCliTurnHandler(engine);
      const stream = start({
        text: 'please read this',
        attachments: [{ path: filePath, displayName: 'note.txt' }],
      });
      await collectEvents(stream);

      expect(seenFileName).toBe('note.txt');
      expect(new TextDecoder().decode(seenBytes)).toBe('hello attachment');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('sanitizes attachment-not-file errors before emitting meta', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'homie-cli-turn-dir-'));
    try {
      let called = false;
      const engine = {
        handleIncomingMessage: async (_msg: IncomingMessage): Promise<OutgoingAction> => {
          called = true;
          return { kind: 'send_text', text: 'ok' };
        },
      };
      const start = createCliTurnHandler(engine);
      const events = await collectEvents(
        start({
          text: 'read this',
          attachments: [{ path: dir, displayName: 'folder' }],
        }),
      );
      const meta = events.find((event) => event.type === 'meta')?.value as
        | { type?: string; message?: string }
        | undefined;
      const done = events.at(-1)?.value as
        | { type?: string; result?: { reason?: string } }
        | undefined;
      expect(called).toBeFalse();
      expect(meta?.type).toBe('meta');
      expect(meta?.message).toBe('error: attachment path must point to a file');
      expect(done?.type).toBe('done');
      expect(done?.result?.reason).toBe('turn_error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('sanitizes missing attachment file errors before emitting meta', async () => {
    const missingPath = path.join(tmpdir(), `missing-${Date.now()}-${Math.random()}.txt`);
    const engine = {
      handleIncomingMessage: async (_msg: IncomingMessage): Promise<OutgoingAction> => {
        return { kind: 'send_text', text: 'ok' };
      },
    };
    const start = createCliTurnHandler(engine);
    const events = await collectEvents(
      start({
        text: 'read this',
        attachments: [{ path: missingPath, displayName: 'missing.txt' }],
      }),
    );
    const meta = events.find((event) => event.type === 'meta')?.value as
      | { type?: string; message?: string }
      | undefined;
    const done = events.at(-1)?.value as
      | { type?: string; result?: { reason?: string } }
      | undefined;
    expect(meta?.type).toBe('meta');
    expect(meta?.message).toBe('error: attachment file not found');
    expect(done?.type).toBe('done');
    expect(done?.result?.reason).toBe('turn_error');
  });

  test('surfaces policy errors with safe wallet wording', async () => {
    const engine = {
      handleIncomingMessage: async (): Promise<OutgoingAction> => {
        throw new Error('wallet_policy:per_request_cap_exceeded');
      },
    };
    const start = createCliTurnHandler(engine);
    const events = await collectEvents(start({ text: 'go' }));
    const meta = events.find((event) => event.type === 'meta')?.value as
      | { type?: string; message?: string }
      | undefined;
    expect(meta?.type).toBe('meta');
    expect(meta?.message).toBe('error: payment blocked by wallet policy');
  });
});
