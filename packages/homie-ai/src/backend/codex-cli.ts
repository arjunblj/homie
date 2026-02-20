import { setTimeout as sleep } from 'node:timers/promises';

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

const retryDelayMs = (attempt: number): number => {
  const base = Math.min(1_000 * 2 ** attempt, 30_000);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
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
    const prompt = buildPrompt(params);
    const requestedModel = params.role === 'fast' ? this.fastModel : this.defaultModel;
    const developerInstructions = buildDeveloperInstructions(params);
    const candidates = [requestedModel, ''];

    for (const model of candidates) {
      if (model === '' && requestedModel === '') continue;
      const args = ['exec', prompt, '--json'];
      if (model) args.push('--model', model);
      if (developerInstructions) {
        args.push('--config', `developer_instructions=${JSON.stringify(developerInstructions)}`);
      }

      for (let attempt = 0; attempt <= this.retryAttempts; attempt += 1) {
        const textParts: string[] = [];
        const reasoningParts: string[] = [];
        let lineBuffer = '';

        const processLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const parsed = JSON.parse(trimmed) as CodexItemEvent;
            processItemEvent(parsed, params.stream, textParts, reasoningParts);
          } catch {
            // Skip non-JSON lines.
          }
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

        if (result.code === 0) {
          if (!params.stream) {
            this.parseStdoutBatch(result.stdout, params.stream, textParts, reasoningParts);
          } else if (textParts.length === 0 && result.stdout.trim()) {
            this.parseStdoutBatch(result.stdout, undefined, textParts, reasoningParts);
          }
          const resolvedModel = model || 'codex-default';
          const text = textParts.join('\n').trim();
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

        if (classified.isTransient && attempt < this.retryAttempts) {
          const delayMs = retryDelayMs(attempt);
          this.logger.warn('complete.retry', {
            attempt: attempt + 1,
            maxAttempts: this.retryAttempts + 1,
            delayMs,
          });
          await sleep(delayMs);
          continue;
        }

        const detail = result.stderr || result.stdout || 'unknown error';
        const err = new Error(`codex failed: ${detail}`);
        this.logger.error('complete.failed', errorFields(err));
        throw err;
      }
    }

    throw new Error('codex: all model candidates exhausted');
  }

  private parseStdoutBatch(
    stdout: string,
    observer: CompletionStreamObserver | undefined,
    textParts: string[],
    reasoningParts: string[],
  ): void {
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as CodexItemEvent;
        processItemEvent(parsed, observer, textParts, reasoningParts);
      } catch {
        // Skip non-JSON lines.
      }
    }
  }
}
