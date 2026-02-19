export const extractMdSection = (md: string, header: string): string => {
  const lines = md.replace(/\r\n/gu, '\n').split('\n');
  const target = `## ${header}`.trim();
  const startIdx = lines.findIndex((l) => l.trim() === target);
  if (startIdx < 0) return '';

  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^##\s+/u.test(line.trim())) break;
    out.push(line);
  }
  return out.join('\n').trim();
};

export const normalizeMdBody = (s: string): string => {
  const out = s.replace(/\r\n/gu, '\n').trim();
  return out ? `${out}\n` : '';
};
