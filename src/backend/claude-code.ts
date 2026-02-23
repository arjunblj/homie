import { z } from 'zod';
import { errorFields, log } from '../util/logger.js';
import {
  DEFAULT_TIMEOUTS,
  parseNdjsonLines,
  type SpawnResult,
  type SpawnTimeouts,
  spawnWithTimeouts,
  splitBufferedLines,
} from './spawn.js';
import {
  type CompleteParams,
  type CompletionResult,
  type CompletionStreamObserver,
  type LLMBackend,
  llmContentToText,
} from './types.js';

type ExecLike = (
  args: string[],
  timeouts: SpawnTimeouts,
  stdin?: string | undefined,
  onStdoutChunk?: ((chunk: string) => void) | undefined,
  signal?: AbortSignal | undefined,
) => Promise<SpawnResult>;

const defaultExec: ExecLike = (args, timeouts, stdinData, onStdoutChunk, signal) =>
  spawnWithTimeouts({
    command: 'claude',
    args,
    timeouts,
    stdin: stdinData,
    onStdoutChunk,
    signal,
  });

const buildPromptParts = (params: CompleteParams): { systemPrompt: string; userPrompt: string } => {
  const systemParts: string[] = [];
  const userParts: string[] = [];
  for (const msg of params.messages) {
    const t = llmContentToText(msg.content);
    if (msg.role === 'system') systemParts.push(t.trim());
    else userParts.push(`[${msg.role}] ${t}`);
  }
  return {
    systemPrompt: systemParts.filter(Boolean).join('\n\n').trim(),
    userPrompt: userParts.join('\n').trim(),
  };
};

interface StreamParseState {
  textParts: string[];
  resultText: string;
  toolNames: Map<string, string>;
  lineBuffer: string;
}

interface ClaudeContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface ClaudeDelta {
  type: string;
  text?: string;
  thinking?: string;
}

interface ClaudeStreamEventPayload {
  type: string;
  content_block?: ClaudeContentBlock;
  delta?: ClaudeDelta;
}

interface ClaudeMessage {
  content?: ClaudeContentBlock[];
}

interface ClaudeStreamEvent {
  type: string;
  event?: ClaudeStreamEventPayload;
  message?: ClaudeMessage;
  result?: string;
  is_error?: boolean;
  error?: string;
}

const processStreamLine = (
  line: string,
  state: StreamParseState,
  observer: CompletionStreamObserver,
): void => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    log.debug('claude_code.json_parse_failed', errorFields(err));
    return;
  }
  const result = z.object({ type: z.string() }).passthrough().safeParse(raw);
  if (!result.success) {
    log.debug('claude_code.event_invalid', { issues: result.error.issues });
    return;
  }
  const parsed = result.data as ClaudeStreamEvent;

  if (parsed.type === 'stream_event') {
    const event = parsed.event;
    if (!event) return;
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'tool_use') {
        const toolCallId = String(block.id ?? 'tool');
        const toolName = String(block.name ?? 'tool');
        state.toolNames.set(toolCallId, toolName);
        observer.onToolCall?.({
          toolCallId,
          toolName,
          ...(block.input !== undefined ? { input: block.input } : {}),
        });
      }
      return;
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (!delta) return;
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        state.textParts.push(delta.text);
        observer.onTextDelta?.(delta.text);
        return;
      }
      const deltaType = String(delta.type ?? '');
      if (deltaType.includes('thinking')) {
        const text = String(delta.thinking ?? delta.text ?? '');
        if (text) observer.onReasoningDelta?.(text);
      }
    }
    return;
  }

  if (parsed.type === 'user') {
    const msg = parsed.message;
    const content = msg?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const toolCallId = String(block.tool_use_id ?? 'tool');
      observer.onToolResult?.({
        toolCallId,
        toolName: state.toolNames.get(toolCallId) ?? 'tool',
        output: block.is_error ? { isError: true, content: block.content } : block.content,
      });
    }
    return;
  }

  if (parsed.type === 'result') {
    if (parsed.is_error) {
      const detail =
        typeof parsed.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : 'claude returned an error result';
      throw new Error(detail);
    }
    if (typeof parsed.result === 'string' && parsed.result.trim()) {
      state.resultText = parsed.result.trim();
    }
  }
};

const isAbortLikeError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /aborted|interrupted|cancelled|canceled/iu.test(err.message);
};

export interface ClaudeCodeBackendOptions {
  timeouts?: Partial<SpawnTimeouts>;
  execImpl?: ExecLike;
  defaultModel?: string;
  fastModel?: string;
  defaultEffort?: 'low' | 'medium' | 'high';
  fastEffort?: 'low' | 'medium' | 'high';
}

export class ClaudeCodeBackend implements LLMBackend {
  private readonly logger = log.child({ component: 'claude_code_backend' });
  private readonly timeouts: SpawnTimeouts;
  private readonly execImpl: ExecLike;
  private readonly defaultModel: string;
  private readonly fastModel: string;
  private readonly defaultEffort: 'low' | 'medium' | 'high';
  private readonly fastEffort: 'low' | 'medium' | 'high';

  public constructor(opts: ClaudeCodeBackendOptions = {}) {
    this.timeouts = {
      ...DEFAULT_TIMEOUTS,
      firstByteMs: 60_000,
      totalMs: 300_000,
      ...opts.timeouts,
    };
    this.execImpl = opts.execImpl ?? defaultExec;
    this.defaultModel = opts.defaultModel ?? 'opus';
    this.fastModel = opts.fastModel ?? 'sonnet';
    this.defaultEffort = opts.defaultEffort ?? 'high';
    this.fastEffort = opts.fastEffort ?? 'medium';
  }

  public async complete(params: CompleteParams): Promise<CompletionResult> {
    try {
      const { systemPrompt, userPrompt } = buildPromptParts(params);
      const model = params.role === 'fast' ? this.fastModel : this.defaultModel;
      const effort = params.role === 'fast' ? this.fastEffort : this.defaultEffort;
      const useStreaming = Boolean(params.stream);
      const args = [
        '--print',
        '--output-format',
        useStreaming ? 'stream-json' : 'json',
        '--model',
        model,
        '--effort',
        effort,
        '--max-turns',
        String(Math.max(1, params.maxSteps)),
        ...(useStreaming ? ['--verbose', '--include-partial-messages'] : []),
        ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
      ];

      const state: StreamParseState = {
        textParts: [],
        resultText: '',
        toolNames: new Map(),
        lineBuffer: '',
      };
      let streamError: Error | undefined;
      const recordStreamError = (
        scope: 'complete.stream_line_failed' | 'complete.stream_remainder_failed',
        err: unknown,
        extra?: { linePreview?: string | undefined },
      ): void => {
        const normalized = err instanceof Error ? err : new Error(String(err));
        if (!streamError) streamError = normalized;
        this.logger.warn(scope, {
          ...(extra ?? {}),
          ...errorFields(normalized),
        });
      };

      const onChunk = useStreaming
        ? (chunk: string): void => {
            state.lineBuffer += chunk;
            const { lines, remainder } = splitBufferedLines(state.lineBuffer);
            state.lineBuffer = remainder;
            for (const line of lines) {
              try {
                if (params.stream) processStreamLine(line, state, params.stream);
              } catch (err) {
                recordStreamError('complete.stream_line_failed', err, {
                  linePreview: line.slice(0, 120),
                });
              }
            }
          }
        : undefined;

      const result = await this.execImpl(args, this.timeouts, userPrompt, onChunk, params.signal);

      if (result.timedOut === 'first-byte') {
        const err = new Error('claude: no response received (first-byte timeout)');
        this.logger.error('complete.first_byte_timeout', errorFields(err));
        throw err;
      }

      if (useStreaming) {
        if (state.lineBuffer.trim()) {
          try {
            if (params.stream) processStreamLine(state.lineBuffer, state, params.stream);
          } catch (err) {
            recordStreamError('complete.stream_remainder_failed', err);
          }
        }
        if (streamError) {
          this.logger.error('complete.stream_failed', errorFields(streamError));
          throw streamError;
        }
      }

      if (result.code !== 0) {
        const detail = result.stderr || result.stdout || 'unknown error';
        const err = new Error(`claude failed: ${detail}`);
        this.logger.error('complete.failed', errorFields(err));
        throw err;
      }

      if (useStreaming) {
        const text = (state.textParts.join('') || state.resultText).trim();
        params.stream?.onFinish?.();
        return { text, steps: [{ type: 'llm', text }], modelId: model };
      }

      const events = parseNdjsonLines(result.stdout);
      let text = '';
      for (const event of events) {
        const obj = event as ClaudeStreamEvent;
        if (typeof obj.result === 'string' && obj.result.trim()) {
          text = obj.result.trim();
          break;
        }
      }
      if (!text) {
        for (const event of events) {
          const obj = event as { type?: unknown; text?: unknown };
          if (obj.type === 'assistant' && typeof obj.text === 'string' && obj.text.trim()) {
            text = (obj.text as string).trim();
            break;
          }
        }
      }
      if (!text) text = result.stdout.trim();
      params.stream?.onFinish?.();
      return { text, steps: [{ type: 'llm', text }], modelId: model };
    } catch (err) {
      if (isAbortLikeError(err)) {
        params.stream?.onAbort?.();
      } else {
        params.stream?.onError?.(err);
      }
      throw err;
    }
  }
}
