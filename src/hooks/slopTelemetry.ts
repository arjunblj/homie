import { checkSlop } from '../behavior/slop.js';
import type { TelemetryStore } from '../telemetry/types.js';
import { errorFields, type Logger } from '../util/logger.js';
import type { AgentHooks } from './types.js';

export function createSlopTelemetryHook(opts: {
  readonly telemetry: TelemetryStore | undefined;
  readonly logger: Logger;
}): AgentHooks {
  const { telemetry, logger } = opts;
  if (!telemetry) return {};

  return {
    onTurnComplete: async (ctx) => {
      const responseText = ctx.responseText?.trim() ?? '';
      if (!responseText) return;

      try {
        const r = checkSlop(responseText);
        const categories = [...new Set(r.violations.map((v) => v.category))];
        telemetry.logSlop({
          chatId: String(ctx.chatId),
          createdAtMs: Date.now(),
          isGroup: ctx.isGroup,
          action: ctx.action.kind,
          score: r.score,
          categories,
        });
      } catch (err) {
        // Never fail turns due to telemetry IO or slop parsing.
        logger.debug('hook.slop_telemetry.failed', errorFields(err));
      }
    },
  };
}
