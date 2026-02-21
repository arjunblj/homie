import type { ChatId } from '../types/ids.js';

export type ParsedChatId =
  | { readonly channel: 'signal'; readonly kind: 'dm'; readonly id: string }
  | { readonly channel: 'signal'; readonly kind: 'group'; readonly id: string }
  | { readonly channel: 'telegram'; readonly kind: 'dm'; readonly id: string }
  | { readonly channel: 'telegram'; readonly kind: 'group'; readonly id: string }
  | { readonly channel: 'cli'; readonly kind: 'local'; readonly id: string };

export const parseChatId = (chatId: ChatId | string): ParsedChatId | null => {
  const raw = String(chatId);
  if (raw.startsWith('signal:dm:')) {
    const id = raw.slice('signal:dm:'.length);
    return id ? { channel: 'signal', kind: 'dm', id } : null;
  }
  if (raw.startsWith('signal:group:')) {
    const id = raw.slice('signal:group:'.length);
    return id ? { channel: 'signal', kind: 'group', id } : null;
  }
  if (raw.startsWith('tg:')) {
    const id = raw.slice('tg:'.length);
    if (!id) return null;
    return id.startsWith('-')
      ? { channel: 'telegram', kind: 'group', id }
      : { channel: 'telegram', kind: 'dm', id };
  }
  if (raw.startsWith('cli:')) {
    const id = raw.slice('cli:'.length);
    return { channel: 'cli', kind: 'local', id: id || 'local' };
  }
  return null;
};
