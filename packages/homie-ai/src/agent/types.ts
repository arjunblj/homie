import type { ChatId, MessageId } from '../types/ids.js';
import type { IncomingAttachment } from './attachments.js';

export type ChannelName = 'cli' | 'signal' | 'telegram';

export interface IncomingMessage {
  channel: ChannelName;
  chatId: ChatId;
  messageId: MessageId;
  authorId: string;
  authorDisplayName?: string | undefined;
  text: string;
  attachments?: readonly IncomingAttachment[] | undefined;
  isGroup: boolean;
  isOperator?: boolean;
  mentioned?: boolean;
  timestampMs: number;
}

export const channelUserId = (msg: IncomingMessage): string => `${msg.channel}:${msg.authorId}`;

export interface OutgoingMessage {
  channel: ChannelName;
  chatId: ChatId;
  text: string;
}
