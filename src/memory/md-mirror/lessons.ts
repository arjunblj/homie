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

  const promoted = lessons.filter((l) => l.promoted === true);
  const rest = lessons.filter((l) => l.promoted !== true);

  if (promoted.length > 0) {
    lines.push('## Heuristics');
    lines.push('');
  }

  const render = (l: Lesson): void => {
    const rule = l.rule?.trim();
    const body = rule || l.content.trim();
    const meta: string[] = [];
    if (l.type) meta.push(`type=${l.type}`);
    if (l.personId) meta.push(`person=${String(l.personId)}`);
    if (typeof l.confidence === 'number') meta.push(`confidence=${l.confidence.toFixed(2)}`);
    if (typeof l.timesValidated === 'number' && l.timesValidated > 0) {
      meta.push(`validated=${l.timesValidated}`);
    }
    if (typeof l.timesViolated === 'number' && l.timesViolated > 0) {
      meta.push(`violated=${l.timesViolated}`);
    }
    const metaStr = meta.length > 0 ? ` (${meta.join(', ')})` : '';
    lines.push(`- ${normalizeMdBody(body).trim()}${metaStr}`);
  };

  for (const l of promoted) render(l);

  if (rest.length > 0) {
    if (promoted.length > 0) {
      lines.push('');
    }
    lines.push('## Recent lessons');
    lines.push('');
    for (const l of rest) render(l);
  }

  lines.push('');
  return lines.join('\n');
};
