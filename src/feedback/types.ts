import type { ChatId } from '../types/ids.js';

export type FeedbackChannel = 'signal' | 'telegram' | 'cli';

export type TrackedOutgoingMessageType = 'reactive' | 'proactive';

export type OutgoingMessageRef =
  | {
      readonly channel: 'signal';
      /** signal reactions identify targets by (author, timestamp). */
      readonly targetAuthor: string;
      readonly targetTimestampMs: number;
    }
  | {
      readonly channel: 'telegram';
      readonly messageId: number;
    }
  | {
      readonly channel: 'cli';
      readonly id: string;
    };

const serializeOutgoingRef = (ref: OutgoingMessageRef): string => {
  switch (ref.channel) {
    case 'signal':
      return `signal:${ref.targetAuthor}:${ref.targetTimestampMs}`;
    case 'telegram':
      return `telegram:${ref.messageId}`;
    case 'cli':
      return `cli:${ref.id}`;
    default:
      // exhaustive; keep runtime safe
      return 'unknown';
  }
};

// Feedback storage enforces global uniqueness on `refKey`, but some channels (Telegram)
// only provide per-chat message IDs. Always namespace by chatId to avoid collisions.
export const makeOutgoingRefKey = (chatId: ChatId, ref: OutgoingMessageRef): string => {
  return `${String(chatId)}|${serializeOutgoingRef(ref)}`;
};

export interface TrackedOutgoing {
  readonly chatId: ChatId;
  readonly channel: FeedbackChannel;
  readonly refKey: string;
  readonly isGroup: boolean;
  readonly sentAtMs: number;
  readonly text: string;
  readonly messageType: TrackedOutgoingMessageType;
  /**
   * Optional metadata for proactive sends so we can learn which outreach kinds
   * work (and avoid repeating what fails).
   */
  readonly proactiveEventId?: string | undefined;
  readonly proactiveKind?: string | undefined;
  readonly proactiveSubject?: string | undefined;
  /** Primary user in the conversation (DM), if known. */
  readonly primaryChannelUserId?: string | undefined;
}

export interface IncomingReactionEvent {
  readonly channel: FeedbackChannel;
  readonly chatId: ChatId;
  readonly targetRefKey: string;
  readonly emoji: string;
  readonly isRemove: boolean;
  readonly authorId?: string | undefined;
  readonly timestampMs: number;
}

export interface IncomingReplyEvent {
  readonly channel: FeedbackChannel;
  readonly chatId: ChatId;
  readonly authorId: string;
  readonly text: string;
  readonly replyToRefKey?: string | undefined;
  readonly timestampMs: number;
}
