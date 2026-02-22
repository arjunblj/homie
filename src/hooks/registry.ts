import type { ChatId } from '../types/ids.js';
import { errorFields, type Logger } from '../util/logger.js';
import type { AgentHooks } from './types.js';

const asError = (err: unknown): Error => {
  if (err instanceof Error) return err;
  return new Error(String(err));
};

const tryGetChatId = (ctx: unknown): ChatId | undefined => {
  if (!ctx || typeof ctx !== 'object') return undefined;
  const maybe = (ctx as Record<string, unknown>)['chatId'];
  return typeof maybe === 'string' ? (maybe as ChatId) : undefined;
};

export class HookRegistry {
  private readonly hooks: AgentHooks[] = [];

  public constructor(private readonly logger: Logger) {}

  public register(hooks: AgentHooks): void {
    this.hooks.push(hooks);
  }

  public async emit<K extends keyof AgentHooks>(
    event: K,
    ctx: Parameters<NonNullable<AgentHooks[K]>>[0],
  ): Promise<void> {
    const chatId = tryGetChatId(ctx);
    for (const h of this.hooks) {
      const fn = h[event];
      if (!fn) continue;
      try {
        await (fn as (arg: typeof ctx) => Promise<void>)(ctx);
      } catch (err) {
        // Hooks must never crash turns, but they also must never fail silently.
        this.logger.warn('hook_failed', {
          event: String(event),
          ...(chatId ? { chatId: String(chatId) } : {}),
          ...errorFields(err),
        });

        if (event === 'onError') continue;
        const onError = h.onError;
        if (!onError) continue;
        try {
          await onError({ ...(chatId ? { chatId } : {}), error: asError(err) });
        } catch (err2) {
          this.logger.warn('hook_onError_failed', {
            event: String(event),
            ...(chatId ? { chatId: String(chatId) } : {}),
            ...errorFields(err2),
          });
        }
      }
    }
  }
}
