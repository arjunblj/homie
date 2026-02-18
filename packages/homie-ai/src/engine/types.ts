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
      kind: 'send_audio';
      /**
       * Transcript / fallback text for platforms that can't send audio.
       * Also used for session/memory logging (we never persist raw audio).
       */
      text: string;
      mime: string;
      filename: string;
      bytes: Uint8Array;
      asVoiceNote?: boolean | undefined;
    }
  | {
      kind: 'react';
      emoji: string;
      targetAuthorId: string;
      targetTimestampMs: number;
    };
