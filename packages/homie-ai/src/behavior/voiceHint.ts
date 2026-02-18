/**
 * Detect whether the user is requesting a voice/audio reply.
 * Conservative: only triggers on explicit voice-related keywords.
 */
export function userRequestedVoiceNote(msgText: string): boolean {
  const t = msgText.toLowerCase();
  if (!t.trim()) return false;
  return Boolean(
    t.includes('voice note') ||
      t.includes('voicenote') ||
      t.includes('audio message') ||
      /\b(send|reply)\b.*\bvoice\b/u.test(t),
  );
}
