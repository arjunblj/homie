import { channelUserId } from '../agent/types.js';
import type { MemoryStore } from '../memory/store.js';
import { asPersonId } from '../types/ids.js';
import { errorFields, type Logger } from '../util/logger.js';
import type { AgentHooks } from './types.js';

export function createGroupTrackerHook(opts: {
  readonly memoryStore: MemoryStore | undefined;
  readonly logger: Logger;
}): AgentHooks {
  const { memoryStore, logger } = opts;
  if (!memoryStore) return {};

  return {
    onTurnComplete: async (ctx) => {
      if (!ctx.isGroup) return;
      const incoming = ctx.incomingMessages;
      if (!incoming || incoming.length === 0) return;

      const nowMs = Date.now();
      if (ctx.action.kind === 'silence') {
        try {
          await memoryStore.markGroupCapsuleDirty(ctx.chatId, nowMs);
        } catch (err) {
          logger.debug('hook.group_tracker.mark_dirty_failed', errorFields(err));
        }
      }

      // Bound work per turn; batch drains can be large in rapid group chats.
      const bounded = incoming.slice(-25);

      const seen = new Set<string>();
      for (const msg of bounded) {
        const cid = channelUserId(msg);
        if (seen.has(cid)) continue;
        seen.add(cid);

        try {
          const existing = await memoryStore.getPersonByChannelId(cid);
          await memoryStore.trackPerson({
            id: existing?.id ?? asPersonId(`person:${cid}`),
            displayName: msg.authorDisplayName ?? msg.authorId,
            channel: msg.channel,
            channelUserId: cid,
            relationshipScore: existing?.relationshipScore ?? 0,
            ...(existing?.trustTierOverride
              ? { trustTierOverride: existing.trustTierOverride }
              : {}),
            ...(existing?.capsule ? { capsule: existing.capsule } : {}),
            ...(existing?.capsuleUpdatedAtMs
              ? { capsuleUpdatedAtMs: existing.capsuleUpdatedAtMs }
              : {}),
            ...(existing?.publicStyleCapsule
              ? { publicStyleCapsule: existing.publicStyleCapsule }
              : {}),
            createdAtMs: existing?.createdAtMs ?? nowMs,
            updatedAtMs: nowMs,
          });
        } catch (err) {
          logger.debug('hook.group_tracker.track_person_failed', {
            channelUserId: cid,
            ...errorFields(err),
          });
        }
      }
    },
  };
}
