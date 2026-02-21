import type { CompletionStreamObserver } from './types.js';

export const collectStreamTextAndEvents = async (
  // AI SDK stream generics are provider/tool dependent; keep this helper generic.
  // biome-ignore lint/suspicious/noExplicitAny: generic SDK stream shape
  result: any,
  observer: CompletionStreamObserver,
): Promise<string> => {
  const chunks: string[] = [];
  let toolSeq = 0;
  const nextToolId = (): string => {
    toolSeq += 1;
    return `tool-${toolSeq}`;
  };
  const toolNames = new Map<string, string>();

  for await (const part of result.fullStream) {
    if (!part || typeof part.type !== 'string') continue;
    if (part.type === 'text-delta') {
      const delta = (part as { text?: string }).text ?? '';
      if (delta) {
        chunks.push(delta);
        observer.onTextDelta?.(delta);
      }
      continue;
    }

    if (part.type === 'reasoning-delta') {
      const delta = (part as { text?: string }).text ?? '';
      if (delta) observer.onReasoningDelta?.(delta);
      continue;
    }

    if (part.type === 'tool-input-start') {
      const input = part as { id?: string; toolName?: string };
      const toolCallId = input.id ?? nextToolId();
      const toolName = input.toolName ?? 'tool';
      toolNames.set(toolCallId, toolName);
      observer.onToolInputStart?.({ toolCallId, toolName });
      continue;
    }

    if (part.type === 'tool-call-streaming-start') {
      const input = part as { toolCallId?: string; toolName?: string };
      const toolCallId = input.toolCallId ?? nextToolId();
      const toolName = input.toolName ?? 'tool';
      toolNames.set(toolCallId, toolName);
      observer.onToolInputStart?.({ toolCallId, toolName });
      continue;
    }

    if (part.type === 'tool-input-delta') {
      const input = part as { id?: string; delta?: string };
      const toolCallId = input.id ?? nextToolId();
      const toolName = toolNames.get(toolCallId) ?? 'tool';
      const delta = input.delta ?? '';
      if (delta) observer.onToolInputDelta?.({ toolCallId, toolName, delta });
      continue;
    }

    if (part.type === 'tool-call-delta') {
      const input = part as { toolCallId?: string; argsTextDelta?: string; delta?: string };
      const toolCallId = input.toolCallId ?? nextToolId();
      const toolName = toolNames.get(toolCallId) ?? 'tool';
      const delta = input.argsTextDelta ?? input.delta ?? '';
      if (delta) observer.onToolInputDelta?.({ toolCallId, toolName, delta });
      continue;
    }

    if (part.type === 'tool-input-end') {
      const input = part as { id?: string };
      const toolCallId = input.id ?? nextToolId();
      const toolName = toolNames.get(toolCallId) ?? 'tool';
      observer.onToolInputEnd?.({ toolCallId, toolName });
      continue;
    }

    if (part.type === 'tool-call') {
      const tool = part as {
        toolCallId?: string;
        id?: string;
        toolName?: string;
        toolNameNormalized?: string;
        input?: unknown;
      };
      const toolCallId = tool.toolCallId ?? tool.id ?? nextToolId();
      const toolName = tool.toolName ?? tool.toolNameNormalized ?? 'tool';
      toolNames.set(toolCallId, toolName);
      observer.onToolCall?.({
        toolCallId,
        toolName,
        ...(tool.input !== undefined ? { input: tool.input } : {}),
      });
      continue;
    }

    if (part.type === 'tool-result') {
      const tool = part as {
        toolCallId?: string;
        id?: string;
        toolName?: string;
        output?: unknown;
        result?: unknown;
      };
      const toolCallId = tool.toolCallId ?? tool.id ?? nextToolId();
      const toolName = tool.toolName ?? toolNames.get(toolCallId) ?? 'tool';
      observer.onToolResult?.({
        toolCallId,
        toolName,
        ...((tool.output ?? tool.result) !== undefined
          ? { output: tool.output ?? tool.result }
          : {}),
      });
      continue;
    }

    if (part.type === 'abort') {
      observer.onAbort?.();
      continue;
    }

    if (part.type === 'error') {
      observer.onError?.((part as { error?: unknown }).error ?? part);
    }
  }

  const streamed = chunks.join('').trim();
  if (streamed) return streamed;

  const fallback = (await result.text).trim();
  if (fallback) observer.onTextDelta?.(fallback);
  return fallback;
};
