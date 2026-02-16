export type OutgoingAction =
  | {
      kind: 'silence';
      reason?: string | undefined;
    }
  | {
      kind: 'send_text';
      text: string;
    }
  | {
      kind: 'react';
      emoji: string;
      targetAuthorId: string;
      targetTimestampMs: number;
    };

