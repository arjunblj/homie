import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from '../../agent/types.js';
import type { OutgoingAction } from '../../engine/types.js';
import { asChatId, asMessageId } from '../../types/ids.js';
import { runTurnWithTimeout } from './eval.js';

const makeMessage = (): IncomingMessage => ({
  channel: 'cli',
  chatId: asChatId('cli:eval-test'),
  messageId: asMessageId('cli:eval-test:1'),
  authorId: 'user',
  text: 'hello',
  isGroup: false,
  isOperator: false,
  timestampMs: Date.now(),
});

describe('runTurnWithTimeout', () => {
  test('returns successful turn output', async () => {
    const msg = makeMessage();
    const engine = {
      handleIncomingMessage: async (): Promise<OutgoingAction> => ({
        kind: 'send_text',
        text: 'ok',
      }),
    };
    const out = await runTurnWithTimeout(engine, msg, 500);
    expect(out.kind).toBe('send_text');
  });

  test('aborts and throws timeout error when turn exceeds timeout', async () => {
    const msg = makeMessage();
    const engine = {
      handleIncomingMessage: async (
        _msg: IncomingMessage,
        _observer?: unknown,
        opts?: { signal?: AbortSignal | undefined },
      ): Promise<OutgoingAction> => {
        return await new Promise<OutgoingAction>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => {
              reject(opts.signal?.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        });
      },
    };

    await expect(runTurnWithTimeout(engine, msg, 30)).rejects.toThrow('eval turn timed out');
  });
});
