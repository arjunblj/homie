export const isEffectivelyEmpty = (s: string): boolean => {
  const t = s.trim();
  return !t || t === '(empty)';
};

export function extractMdSection(md: string, header: string): string {
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
}

export function normalizeMdBody(s: string): string {
  const out = s.replace(/\r\n/gu, '\n').trim();
  return out ? `${out}\n` : '';
}
