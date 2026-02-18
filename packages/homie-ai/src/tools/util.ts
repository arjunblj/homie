const escapeXmlAttr = (input: string): string => {
  // Attribute-safe: prevents breaking out of `title="..."`.
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
};

const escapeXmlText = (input: string): string => {
  // Text-safe: prevents injecting nested tags (e.g. `</external>`).
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
};

const normalizeExternalTitle = (title: string): string => {
  // Avoid control characters/newlines inside the opening tag.
  let out = '';
  for (const ch of title) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp < 0x20 || cp === 0x7f ? ' ' : ch;
  }
  return out.trim();
};

export const wrapExternal = (title: string, content: string): string => {
  const safeTitle = escapeXmlAttr(normalizeExternalTitle(title));
  const safeContent = escapeXmlText(content);
  return [`<external title="${safeTitle}">`, safeContent, '</external>'].join('\n');
};

export const truncateBytes = (input: string, maxBytes: number): string => {
  const enc = new TextEncoder();
  const bytes = enc.encode(input);
  if (bytes.byteLength <= maxBytes) return input;
  const truncated = bytes.slice(0, maxBytes);
  return new TextDecoder().decode(truncated);
};
