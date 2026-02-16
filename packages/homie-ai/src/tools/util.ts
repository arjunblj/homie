export const wrapExternal = (title: string, content: string): string => {
  // "XML isolation": make it very obvious which content is untrusted.
  const safeTitle = title.replace(/[<>&]/gu, '');
  return [`<external title="${safeTitle}">`, content, '</external>'].join('\n');
};

export const truncateBytes = (input: string, maxBytes: number): string => {
  const enc = new TextEncoder();
  const bytes = enc.encode(input);
  if (bytes.byteLength <= maxBytes) return input;
  const truncated = bytes.slice(0, maxBytes);
  return new TextDecoder().decode(truncated);
};
