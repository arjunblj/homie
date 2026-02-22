import { type Tool as AiTool, tool } from 'ai';

import type { ToolContext, ToolDef } from '../tools/types.js';
import { estimateTokens, truncateToTokenBudget } from '../util/tokens.js';

const DEFAULT_TOOL_OUTPUT_MAX_TOKENS = 900;

const safeToolName = (toolName: string): string => toolName.replace(/[^a-z0-9:_-]/giu, '_');

const isWrappedExternal = (text: string): boolean => {
  const t = text.trimStart();
  return t.startsWith('<external') && t.includes('</external>');
};

const isLikelyJson = (text: string): boolean => {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
};

const truncateExternalWrapped = (
  xml: string,
  budgetTokens: number,
): { text: string; changed: boolean } => {
  // Preserve the wrapper so the model sees well-formed XML even when truncated.
  const t = xml.trim();
  const openEnd = t.indexOf('>\n');
  const closeStart = t.lastIndexOf('\n</external>');
  if (openEnd === -1 || closeStart === -1 || closeStart <= openEnd) {
    const truncated = truncateToTokenBudget(t, budgetTokens);
    return { text: truncated, changed: truncated !== t };
  }
  const openTag = t.slice(0, openEnd + 2); // includes ">\n"
  const inner = t.slice(openEnd + 2, closeStart);
  const closeTag = t.slice(closeStart + 1); // includes "</external>"
  const innerBudget = Math.max(
    0,
    budgetTokens - estimateTokens(openTag) - estimateTokens(closeTag),
  );
  const truncatedInner = truncateToTokenBudget(inner, innerBudget);
  const out = `${openTag}${truncatedInner}\n${closeTag}`;
  return { text: out, changed: truncatedInner !== inner };
};

function pruneJsonForTokenBudget(value: unknown, maxTokens: number): unknown {
  const original = JSON.stringify(value);
  if (!original) return value;
  if (estimateTokens(original) <= maxTokens) return value;

  const capStr = (s: string, cap: number): string => {
    if (s.length <= cap) return s;
    return `${s.slice(0, cap).trim()}…`;
  };

  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 5) return '[…]';
    if (v === null) return null;
    if (typeof v === 'string') return capStr(v, 800);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => visit(x, depth + 1));
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).slice(0, 60);
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = visit(obj[k], depth + 1);
      return out;
    }
    return String(v);
  };

  return visit(value, 0);
}

export const wrapToolOutputText = (toolName: string, raw: string): string => {
  return wrapToolOutputTextWithBudget(toolName, raw, DEFAULT_TOOL_OUTPUT_MAX_TOKENS);
};

const wrapToolOutputTextWithBudget = (toolName: string, raw: string, maxTokens: number): string => {
  const name = safeToolName(toolName);
  const text = raw.trim();

  let content = text;
  let changed = false;

  if (isWrappedExternal(content)) {
    const capped = truncateExternalWrapped(content, maxTokens);
    changed = capped.changed;
    content = capped.text;
  } else if (isLikelyJson(content)) {
    try {
      const parsed = JSON.parse(content) as unknown;
      const pruned = pruneJsonForTokenBudget(parsed, maxTokens);
      const prunedJson = JSON.stringify(pruned);
      const didPrune = prunedJson !== JSON.stringify(parsed);
      const json = JSON.stringify(pruned);
      const capped = truncateToTokenBudget(json ?? content, maxTokens);
      changed = didPrune || capped !== (json ?? content);
      content = capped;
    } catch (_err) {
      const capped = truncateToTokenBudget(content, maxTokens);
      changed = capped !== content;
      content = capped;
    }
  } else {
    const capped = truncateToTokenBudget(content, maxTokens);
    changed = capped !== content;
    content = capped;
  }

  // Prevent tool output from injecting an early close tag for our wrapper.
  const safeContent = content.replaceAll('</tool_output>', '</tool_output_>');
  return `<tool_output name="${name}" truncated="${changed ? 'true' : 'false'}">\n${safeContent}\n</tool_output>`;
};

export const toolDefsToAiTools = (
  defs: readonly ToolDef[] | undefined,
  rootSignal: AbortSignal | undefined,
  toolContext: Omit<ToolContext, 'now' | 'signal'> | undefined,
): Record<string, AiTool> => {
  const out: Record<string, AiTool> = {};
  if (!defs) return out;

  for (const def of defs) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input) => {
        const timeoutMs = def.timeoutMs ?? 60_000;
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );

        const onAbort = (): void => {
          if (controller.signal.aborted) return;
          const reason = rootSignal?.reason;
          controller.abort(reason ?? new Error('Aborted'));
        };
        if (rootSignal) {
          if (rootSignal.aborted) onAbort();
          else rootSignal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          const result = await def.execute(input, {
            ...(toolContext ?? {}),
            now: new Date(),
            signal: controller.signal,
          });
          const budget = toolContext?.toolOutput;
          const maxTokens = budget
            ? Math.max(0, Math.min(budget.maxTokensPerTool, budget.remainingTokens))
            : DEFAULT_TOOL_OUTPUT_MAX_TOKENS;

          const wrapped =
            typeof result === 'string'
              ? wrapToolOutputTextWithBudget(def.name, result, maxTokens)
              : (() => {
                  try {
                    return wrapToolOutputTextWithBudget(
                      def.name,
                      JSON.stringify(result) ?? String(result),
                      maxTokens,
                    );
                  } catch (_err) {
                    return wrapToolOutputTextWithBudget(def.name, String(result), maxTokens);
                  }
                })();

          if (budget) {
            const used = estimateTokens(wrapped);
            budget.remainingTokens = Math.max(0, budget.remainingTokens - used);
            budget.onToolOutput?.({
              toolName: def.name,
              tokensUsed: used,
              truncated: wrapped.includes('truncated="true"'),
            });
          }

          return wrapped;
        } finally {
          clearTimeout(timer);
          if (rootSignal) rootSignal.removeEventListener('abort', onAbort);
        }
      },
    });
  }
  return out;
};
