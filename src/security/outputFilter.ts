const redactPatterns = (input: string): string => {
  let s = input;
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/gu, 'Bearer [REDACTED]');
  s = s.replace(/bot\d+:[A-Za-z0-9_-]+/gu, 'bot[REDACTED]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, 'sk-[REDACTED]');
  s = s.replace(/\b0x[a-fA-F0-9]{64}\b/gu, '0x[REDACTED]');
  return s;
};

export const filterOutgoingText = (text: string): { text: string; redacted: boolean } => {
  const next = redactPatterns(text);
  return { text: next, redacted: next !== text };
};
