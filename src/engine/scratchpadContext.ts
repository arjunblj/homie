import type { SessionStore } from '../session/types.js';
import { wrapExternal } from '../tools/util.js';
import type { ChatId } from '../types/ids.js';
import { truncateToTokenBudget } from '../util/tokens.js';

export const SCRATCHPAD_TOKEN_BUDGET = 350;
export const SCRATCHPAD_MAX_NOTES = 24;

export const buildScratchpadDataMessage = (opts: {
  sessionStore: SessionStore | undefined;
  chatId: ChatId;
  tokenBudget?: number | undefined;
  maxNotes?: number | undefined;
}): { role: 'user'; content: string } | null => {
  const store = opts.sessionStore;
  if (!store) return null;

  const limit = Math.max(0, Math.min(200, Math.floor(opts.maxNotes ?? SCRATCHPAD_MAX_NOTES)));
  const notes = store.listNotes(opts.chatId, limit);
  if (notes.length === 0) return null;

  const blocks: string[] = ['=== SCRATCHPAD (DATA) ==='];
  for (const n of notes) {
    const key = n.key.trim();
    const body = n.content.trim();
    if (!key || !body) continue;
    blocks.push(`--- ${key} ---\n${body}`);
  }
  if (blocks.length <= 1) return null;

  const budget = Math.max(0, Math.floor(opts.tokenBudget ?? SCRATCHPAD_TOKEN_BUDGET));
  const text = truncateToTokenBudget(blocks.join('\n\n'), budget);
  return { role: 'user', content: wrapExternal('scratchpad', text) };
};
