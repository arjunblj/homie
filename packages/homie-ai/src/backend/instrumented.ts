import { randomUUID } from 'node:crypto';
import type { TelemetryStore } from '../telemetry/types.js';
import { errorFields, getLogContext, log } from '../util/logger.js';
import type { CompleteParams, CompletionResult, LLMBackend, LLMUsage } from './types.js';

const usageToTotals = (usage: LLMUsage | undefined) => {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
  };
};

export function createInstrumentedBackend(options: {
  backend: LLMBackend;
  telemetry: TelemetryStore;
  defaultCaller?: string | undefined;
}): LLMBackend {
  const defaultCaller = options.defaultCaller ?? 'llm';
  const logger = log.child({ component: 'instrumented_backend' });
  return {
    complete: async (params: CompleteParams): Promise<CompletionResult> => {
      const ctx = getLogContext();
      const correlationId =
        // biome-ignore lint/complexity/useLiteralKeys: ctx is a loose record.
        typeof ctx['turnId'] === 'string'
          ? // biome-ignore lint/complexity/useLiteralKeys: ctx is a loose record.
            ctx['turnId']
          : undefined;
      const caller =
        // biome-ignore lint/complexity/useLiteralKeys: ctx is a loose record.
        typeof ctx['llmCaller'] === 'string'
          ? // biome-ignore lint/complexity/useLiteralKeys: ctx is a loose record.
            ctx['llmCaller']
          : defaultCaller;
      const startedAtMs = Date.now();
      try {
        const res = await options.backend.complete(params);
        const totals = usageToTotals(res.usage);
        try {
          options.telemetry.logLlmCall({
            id: randomUUID(),
            correlationId,
            caller,
            role: params.role,
            modelId: res.modelId ?? undefined,
            startedAtMs,
            durationMs: Date.now() - startedAtMs,
            ok: true,
            ...totals,
          });
        } catch (err) {
          logger.debug('telemetry.logLlmCall_failed', errorFields(err));
        }
        return res;
      } catch (err) {
        const fields = errorFields(err);
        const typed = fields as { errName?: unknown; errMsg?: unknown };
        const errName = typeof typed.errName === 'string' ? typed.errName : undefined;
        const errMsg = typeof typed.errMsg === 'string' ? typed.errMsg : String(err);
        try {
          options.telemetry.logLlmCall({
            id: randomUUID(),
            correlationId,
            caller,
            role: params.role,
            startedAtMs,
            durationMs: Date.now() - startedAtMs,
            ok: false,
            errName,
            errMsg: errMsg.slice(0, 500),
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          });
        } catch (teleErr) {
          logger.debug('telemetry.logLlmCall_failed', errorFields(teleErr));
        }
        throw err;
      }
    },
  };
}
