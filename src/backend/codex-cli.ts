import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import { truncateOneLine } from '../util/format.js';
import { errorFields, log } from '../util/logger.js';
import {
  classifyError,
  DEFAULT_TIMEOUTS,
  type SpawnResult,
  type SpawnTimeouts,
  spawnWithTimeouts,
  splitBufferedLines,
} from './spawn.js';
import type {
  CompleteParams,
  CompletionResult,
  CompletionStreamObserver,
  LLMBackend,
} from './types.js';

type ExecLike = (
  args: string[],
  timeouts: SpawnTimeouts,
  onStdoutChunk?: ((chunk: string) => void) | undefined,
  signal?: AbortSignal | undefined,
) => Promise<SpawnResult>;

const defaultExec: ExecLike = (args, timeouts, onStdoutChunk, signal) =>
  spawnWithTimeouts({ command: 'codex', args, timeouts, onStdoutChunk, signal });

const buildPrompt = (params: CompleteParams): string => {
  const nonSystemParts: string[] = [];
  for (const msg of params.messages) {
    if (msg.role === 'system') continue;
    nonSystemParts.push(`[${msg.role}] ${msg.content}`);
  }
  return nonSystemParts.join('\n').trim();
};

const buildDeveloperInstructions = (params: CompleteParams): string => {
  return params.messages
    .filter((msg) => msg.role === 'system')
    .map((msg) => msg.content.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

interface CodexItem {
  type: string;
  id?: string;
  text?: string;
  command?: string;
  exit_code?: unknown;
  aggregated_output?: unknown;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
}

interface CodexItemEvent {
  type: string;
  item?: CodexItem;
}

const CodexItemEventSchema = z
  .object({
    type: z.string(),
    item: z
      .object({
        type: z.string(),
        id: z.string().optional(),
        text: z.string().optional(),
        command: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const codexLogger = log.child({ component: 'codex_cli_backend' });

const retryDelayMs = (attempt: number): number => {
  const base = Math.min(1_000 * 2 ** attempt, 30_000);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
};

const isAbortLikeError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /aborted|interrupted|cancelled|canceled/iu.test(err.message);
};

const processItemEvent = (
  parsed: CodexItemEvent,
  observer: CompletionStreamObserver | undefined,
  textParts: string[],
  reasoningParts: string[],
): void => {
  const item = parsed.item;
  if (!item || !item.type) return;
  const eventType = String(parsed.type ?? '');
  const itemType = String(item.type);

  if (
    eventType === 'item.completed' &&
    itemType === 'agent_message' &&
    typeof item.text === 'string'
  ) {
    textParts.push(item.text);
    observer?.onTextDelta?.(item.text);
    return;
  }

  if (eventType === 'item.completed' && itemType === 'reasoning' && typeof item.text === 'string') {
    reasoningParts.push(item.text);
    observer?.onReasoningDelta?.(item.text);
    return;
  }

  if (itemType === 'command_execution') {
    const toolId = String(item.id ?? 'shell');
    const command = String(item.command ?? 'command');
    if (eventType === 'item.started') {
      observer?.onToolCall?.({ toolCallId: toolId, toolName: 'shell', input: { command } });
    } else if (eventType === 'item.completed') {
      observer?.onToolResult?.({
        toolCallId: toolId,
        toolName: 'shell',
        output: { exitCode: item.exit_code, output: item.aggregated_output },
      });
    }
    return;
  }

  if (itemType === 'mcp_tool_call') {
    const toolId = String(item.id ?? 'mcp');
    const toolName = typeof item.tool === 'string' ? `mcp:${item.tool}` : 'mcp_tool';
    if (eventType === 'item.started') {
      observer?.onToolCall?.({ toolCallId: toolId, toolName, input: item.arguments });
    } else if (eventType === 'item.completed') {
      observer?.onToolResult?.({ toolCallId: toolId, toolName, output: item.result ?? item.error });
    }
    return;
  }
};

export interface CodexCliBackendOptions {
  timeouts?: Partial<SpawnTimeouts>;
  execImpl?: ExecLike;
  defaultModel?: string;
  fastModel?: string;
  retryAttempts?: number;
}

export class CodexCliBackend implements LLMBackend {
  private readonly logger = log.child({ component: 'codex_cli_backend' });
  private readonly timeouts: SpawnTimeouts;
  private readonly execImpl: ExecLike;
  private readonly defaultModel: string;
  private readonly fastModel: string;
  private readonly retryAttempts: number;

  public constructor(opts: CodexCliBackendOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.execImpl = opts.execImpl ?? defaultExec;
    this.defaultModel = opts.defaultModel ?? 'gpt-5.3-codex';
    this.fastModel = opts.fastModel ?? 'gpt-5.2';
    this.retryAttempts = Math.max(0, opts.retryAttempts ?? 1);
  }

  public async complete(params: CompleteParams): Promise<CompletionResult> {
    try {
      const prompt = buildPrompt(params);
      const requestedModel = (params.role === 'fast' ? this.fastModel : this.defaultModel).trim();
      const developerInstructions = buildDeveloperInstructions(params);
      const candidates = requestedModel ? [requestedModel, ''] : [''];

      for (const model of candidates) {
        const args = ['exec', prompt, '--json'];
        if (model) args.push('--model', model);
        if (developerInstructions) {
          args.push('--config', `developer_instructions=${JSON.stringify(developerInstructions)}`);
        }

        for (let attempt = 0; attempt <= this.retryAttempts; attempt += 1) {
          const textParts: string[] = [];
          const reasoningParts: string[] = [];
          let lineBuffer = '';
          let skippedNonJsonLines = 0;

          const processLine = (line: string): void => {
            const trimmed = line.trim();
            if (!trimmed) return;
            let json: unknown;
            try {
              json = JSON.parse(trimmed);
            } catch (_err) {
              skippedNonJsonLines += 1;
              return;
            }
            const res = CodexItemEventSchema.safeParse(json);
            if (!res.success) {
              codexLogger.debug('processLine.invalid', { error: res.error.message });
              skippedNonJsonLines += 1;
              return;
            }
            processItemEvent(res.data as CodexItemEvent, params.stream, textParts, reasoningParts);
          };

          const onChunk = params.stream
            ? (chunk: string): void => {
                lineBuffer += chunk;
                const { lines, remainder } = splitBufferedLines(lineBuffer);
                lineBuffer = remainder;
                for (const line of lines) processLine(line);
              }
            : undefined;

          const result = await this.execImpl(args, this.timeouts, onChunk, params.signal);
          if (params.stream && lineBuffer.trim()) processLine(lineBuffer);
          if (skippedNonJsonLines > 0) {
            this.logger.debug('complete.stream.skip_non_json_lines', {
              count: skippedNonJsonLines,
              model: model || 'codex-default',
              attempt: attempt + 1,
            });
          }

          if (result.code === 0) {
            if (!params.stream) {
              this.parseStdoutBatch(result.stdout, params.stream, textParts, reasoningParts);
            } else if (textParts.length === 0 && result.stdout.trim()) {
              this.parseStdoutBatch(result.stdout, undefined, textParts, reasoningParts);
            }
            const resolvedModel = model || 'codex-default';
            const text = textParts.join('\n').trim();
            params.stream?.onFinish?.();
            return { text, steps: [{ type: 'llm', text }], modelId: resolvedModel };
          }

          const classified = classifyError(result);

          if (classified.isFirstByteTimeout) {
            const err = new Error('codex: no response received (first-byte timeout)');
            this.logger.error('complete.first_byte_timeout', errorFields(err));
            throw err;
          }

          if (classified.isModelUnavailable && model) {
            this.logger.warn('complete.model_fallback', {
              requestedModel: model,
              fallback: 'codex-default',
            });
            break;
          }

          if (classified.isTransient && params.signal?.aborted) {
            const err = new Error('codex request aborted');
            this.logger.debug('complete.aborted', {
              model: model || 'codex-default',
            });
            throw err;
          }

          if (classified.isTransient && attempt < this.retryAttempts) {
            if (params.stream && (textParts.length > 0 || reasoningParts.length > 0)) {
              this.logger.warn('complete.retry_skipped_after_stream_output', {
                attempt: attempt + 1,
                model: model || 'codex-default',
              });
            } else {
              const delayMs = retryDelayMs(attempt);
              this.logger.warn('complete.retry', {
                attempt: attempt + 1,
                maxAttempts: this.retryAttempts + 1,
                delayMs,
              });
              await sleep(delayMs);
              continue;
            }
          }

          const detail = truncateOneLine(result.stderr || result.stdout || 'unknown error', 280);
          const err = new Error('codex failed: request could not be completed');
          this.logger.error('complete.failed', errorFields(err));
          this.logger.debug('complete.failed.detail', {
            detail,
            exitCode: result.code,
            model: model || 'codex-default',
          });
          throw err;
        }
      }

      throw new Error('codex: all model candidates exhausted');
    } catch (err) {
      if (isAbortLikeError(err)) {
        params.stream?.onAbort?.();
      } else {
        params.stream?.onError?.(err);
      }
      throw err;
    }
  }

  private parseStdoutBatch(
    stdout: string,
    observer: CompletionStreamObserver | undefined,
    textParts: string[],
    reasoningParts: string[],
  ): void {
    let skippedNonJsonLines = 0;
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let json: unknown;
      try {
        json = JSON.parse(trimmed);
      } catch (_err) {
        skippedNonJsonLines += 1;
        continue;
      }
      const res = CodexItemEventSchema.safeParse(json);
      if (!res.success) {
        this.logger.debug('parseStdoutBatch.invalid', { error: res.error.message });
        skippedNonJsonLines += 1;
        continue;
      }
      processItemEvent(res.data as CodexItemEvent, observer, textParts, reasoningParts);
    }
    if (skippedNonJsonLines > 0) {
      this.logger.debug('parse_stdout_batch.skip_non_json_lines', { count: skippedNonJsonLines });
    }
  }
}
