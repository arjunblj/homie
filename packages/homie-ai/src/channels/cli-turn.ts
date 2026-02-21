import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { type IncomingAttachment, kindFromMime } from '../agent/attachments.js';
import type { IncomingMessage } from '../agent/types.js';
import type {
  ChatAttachmentRef,
  ChatTurnEvent,
  ChatTurnInput,
  ChatTurnResult,
  ChatTurnStream,
  ChatTurnStreamer,
} from '../cli/ink/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import type { OutgoingAction, TurnStreamObserver } from '../engine/types.js';
import { asChatId, asMessageId } from '../types/ids.js';

const CLI_CHAT_ID = asChatId('cli:local');
const DEFAULT_DELTA_BATCH_MS = 24;

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
};

const toTurnResult = (action: OutgoingAction): ChatTurnResult => {
  if (action.kind === 'send_text') {
    return { kind: 'send_text', text: action.text };
  }
  if (action.kind === 'react') {
    return { kind: 'react', emoji: action.emoji };
  }
  return { kind: 'silence', reason: action.reason ?? 'no_reply' };
};

const toSafeMetaError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  const low = message.toLowerCase();
  if (low.includes('wallet_policy:')) return 'payment blocked by wallet policy';
  if (low.includes('attachment too large')) return 'attachment too large (max 25MB)';
  if (low.includes('attachment is not a file')) return 'attachment path must point to a file';
  if (low.includes('enoent') || low.includes('no such file')) return 'attachment file not found';
  if (low.includes('eacces') || low.includes('permission denied')) {
    return 'cannot read attachment (permission denied)';
  }
  return 'request failed';
};

export const createCliTurnHandler = (
  engine: Pick<TurnEngine, 'handleIncomingMessage'>,
  opts?: { deltaBatchMs?: number | undefined },
): ChatTurnStreamer => {
  let seq = 0;
  const deltaBatchMs = Math.max(10, Math.min(80, opts?.deltaBatchMs ?? DEFAULT_DELTA_BATCH_MS));

  return (input: ChatTurnInput): ChatTurnStream => {
    seq += 1;
    const controller = new AbortController();
    const eventQueue = createEventQueue();
    const flushState = createDeltaFlushState(eventQueue, deltaBatchMs);

    const observer: TurnStreamObserver = {
      onPhase: (phase) => {
        flushState.flushNow();
        eventQueue.push({ type: 'phase', phase });
      },
      onTextDelta: (delta) => flushState.pushText(delta),
      onReasoningDelta: (delta) => flushState.pushReasoning(delta),
      onToolCall: (event) => {
        flushState.flushNow();
        eventQueue.push({
          type: 'tool_call',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.input !== undefined ? { input: event.input } : {}),
        });
      },
      onToolResult: (event) => {
        flushState.flushNow();
        eventQueue.push({
          type: 'tool_result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.output !== undefined ? { output: event.output } : {}),
        });
      },
      onUsage: (summary) => {
        flushState.flushNow();
        eventQueue.push({ type: 'usage', summary });
      },
      onMeta: (message) => {
        flushState.flushNow();
        eventQueue.push({ type: 'meta', message });
      },
      onReset: () => {
        flushState.flushNow();
        eventQueue.push({ type: 'reset_stream' });
      },
    };

    void (async (): Promise<void> => {
      throwIfAborted(controller.signal);
      const attachments = await buildIncomingAttachments(input.attachments, seq, controller.signal);
      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: CLI_CHAT_ID,
        messageId: asMessageId(`cli:${seq}`),
        authorId: 'operator',
        authorDisplayName: 'operator',
        text: input.text,
        ...(attachments.length ? { attachments } : {}),
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };
      if (attachments.length > 0) {
        eventQueue.push({
          type: 'meta',
          message: `sending ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`,
        });
      }
      if (controller.signal.aborted) {
        throw new Error('aborted');
      }
      const action = await engine.handleIncomingMessage(msg, observer, {
        signal: controller.signal,
      });
      flushState.flushNow();
      eventQueue.push({ type: 'done', result: toTurnResult(action) });
      eventQueue.end();
    })().catch((err) => {
      flushState.flushNow();
      if (controller.signal.aborted) {
        eventQueue.push({
          type: 'done',
          result: { kind: 'silence', reason: 'interrupted' },
        });
        eventQueue.end();
        return;
      }
      eventQueue.push({ type: 'meta', message: `error: ${toSafeMetaError(err)}` });
      eventQueue.push({
        type: 'done',
        result: { kind: 'silence', reason: 'turn_error' },
      });
      eventQueue.end();
    });

    return {
      events: eventQueue.iterable(),
      cancel: () => {
        flushState.flushNow();
        controller.abort(new Error('Interrupted by operator'));
      },
    };
  };
};

interface DeltaFlushState {
  pushText(delta: string): void;
  pushReasoning(delta: string): void;
  flushNow(): void;
}

const createDeltaFlushState = (eventQueue: EventQueue, batchMs: number): DeltaFlushState => {
  let text = '';
  let reasoning = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (text) {
      eventQueue.push({ type: 'text_delta', text });
      text = '';
    }
    if (reasoning) {
      eventQueue.push({ type: 'reasoning_delta', text: reasoning });
      reasoning = '';
    }
  };

  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(flush, batchMs);
  };

  return {
    pushText: (delta: string) => {
      if (!delta) return;
      text += delta;
      schedule();
    },
    pushReasoning: (delta: string) => {
      if (!delta) return;
      reasoning += delta;
      schedule();
    },
    flushNow: flush,
  };
};

const mimeForPath = (filePath: string): string | undefined => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.json') return 'application/json';
  if (ext === '.txt' || ext === '.md') return 'text/plain';
  return undefined;
};

const buildIncomingAttachments = async (
  refs: readonly ChatAttachmentRef[] | undefined,
  turnSeq: number,
  signal?: AbortSignal | undefined,
): Promise<IncomingAttachment[]> => {
  if (!refs || refs.length === 0) return [];
  const maxBytes = 25 * 1024 * 1024;
  return await Promise.all(
    refs.map(async (ref, index) => {
      throwIfAborted(signal);
      const resolved = path.resolve(ref.path);
      const fileStat = await stat(resolved);
      throwIfAborted(signal);
      if (!fileStat.isFile()) {
        throw new Error('Attachment is not a file');
      }
      if (fileStat.size > maxBytes) {
        throw new Error('Attachment too large (>25MB)');
      }
      const mime = mimeForPath(resolved);
      return {
        id: `cli:${turnSeq}:att:${index + 1}`,
        kind: kindFromMime(mime),
        ...(mime ? { mime } : {}),
        sizeBytes: fileStat.size,
        fileName: ref.displayName,
        getBytes: async (): Promise<Uint8Array> => {
          throwIfAborted(signal);
          const bytes = await readFile(resolved);
          throwIfAborted(signal);
          return new Uint8Array(bytes);
        },
      } satisfies IncomingAttachment;
    }),
  );
};

interface EventQueue {
  push(event: ChatTurnEvent): void;
  end(): void;
  iterable(): AsyncIterable<ChatTurnEvent>;
}

const createEventQueue = (): EventQueue => {
  const queue: ChatTurnEvent[] = [];
  let done = false;
  let resolver: ((value: ChatTurnEvent | undefined) => void) | undefined;

  const shift = async (): Promise<ChatTurnEvent | undefined> => {
    if (queue.length > 0) return queue.shift();
    if (done) return undefined;
    return await new Promise((resolve) => {
      resolver = resolve;
    });
  };

  return {
    push(event) {
      if (done) return;
      if (resolver) {
        const r = resolver;
        resolver = undefined;
        r(event);
        return;
      }
      queue.push(event);
    },
    end() {
      done = true;
      if (resolver) {
        const r = resolver;
        resolver = undefined;
        r(undefined);
      }
    },
    iterable() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              const value = await shift();
              if (value === undefined) return { done: true, value: undefined };
              return { done: false, value };
            },
          };
        },
      };
    },
  };
};
