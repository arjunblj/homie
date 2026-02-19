import type { Lesson } from '../types.js';
import { normalizeMdBody } from './sections.js';

export const renderCuratedLessonsMd = (
  lessons: Lesson[],
  updatedAtMs: number = Date.now(),
): string => {
  const lines: string[] = [
    '---',
    'kind: curated_lessons',
    `updatedAtMs: ${updatedAtMs}`,
    '---',
    '',
    '# Curated Lessons',
    '',
  ];

  if (lessons.length === 0) {
    lines.push('(none yet)');
    lines.push('');
    return lines.join('\n');
  }

  for (const l of lessons) {
    const rule = l.rule?.trim();
    const body = rule || l.content.trim();
    const meta: string[] = [];
    if (l.type) meta.push(`type=${l.type}`);
    if (l.personId) meta.push(`person=${String(l.personId)}`);
    if (typeof l.confidence === 'number') meta.push(`confidence=${l.confidence.toFixed(2)}`);
    const metaStr = meta.length > 0 ? ` (${meta.join(', ')})` : '';
    lines.push(`- ${normalizeMdBody(body).trim()}${metaStr}`);
  }

  lines.push('');
  return lines.join('\n');
};
