import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const createMarked = (width: number): Marked => {
  const m = new Marked();
  m.use(
    markedTerminal({
      reflowText: true,
      width: Math.min(width, 100) - 4,
      showSectionPrefix: false,
      tab: 2,
    }) as Parameters<typeof m.use>[0],
  );
  return m;
};

let cachedCols = 0;
let cachedMarked: Marked | undefined;

export function renderMarkdown(text: string): string {
  const cols = process.stdout.columns ?? 80;
  if (!cachedMarked || cols !== cachedCols) {
    cachedCols = cols;
    cachedMarked = createMarked(cols);
  }
  try {
    const rendered = cachedMarked.parse(text);
    if (typeof rendered !== 'string') return text;
    return rendered.replace(/\n+$/u, '');
  } catch (_err) {
    return text;
  }
}
