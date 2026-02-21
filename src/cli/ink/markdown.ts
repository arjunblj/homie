import { stripVTControlCharacters } from 'node:util';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const stripOscSequences = (value: string): string => {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === ESC && value[i + 1] === ']') {
      i += 2;
      while (i < value.length) {
        const cur = value[i];
        if (cur === BEL) {
          i += 1;
          break;
        }
        if (cur === ESC && value[i + 1] === '\\') {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

const createMarked = (width: number): Marked => {
  const m = new Marked();
  m.use(
    markedTerminal({
      reflowText: true,
      width: Math.max(20, Math.min(width, 100) - 4),
      showSectionPrefix: false,
      tab: 2,
    }) as Parameters<typeof m.use>[0],
  );
  return m;
};

let cachedCols = 0;
let cachedMarked: Marked | undefined;

export const sanitizeTerminalText = (value: string): string =>
  stripVTControlCharacters(stripOscSequences(value));

export function renderMarkdown(text: string): string {
  const safeText = sanitizeTerminalText(text);
  const cols = process.stdout.columns ?? 80;
  if (!cachedMarked || cols !== cachedCols) {
    cachedCols = cols;
    cachedMarked = createMarked(cols);
  }
  try {
    const rendered = cachedMarked.parse(safeText);
    if (typeof rendered !== 'string') return safeText;
    return rendered.replace(/\n+$/u, '');
  } catch (_err) {
    return safeText;
  }
}
