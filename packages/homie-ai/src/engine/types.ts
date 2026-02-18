export type OutgoingAction =
  | {
      kind: 'silence';
      reason?: string | undefined;
    }
  | {
      kind: 'send_text';
      text: string;
      /** Hint that the user requested a voice/audio reply. Channel adapters may synthesize TTS. */
      ttsHint?: boolean | undefined;
    }
  | {
      kind: 'react';
      emoji: string;
      targetAuthorId: string;
      targetTimestampMs: number;
    };
