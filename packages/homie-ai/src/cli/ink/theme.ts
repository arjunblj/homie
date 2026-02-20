import gradient from 'gradient-string';
import { detectTerminalCapabilities } from './terminalCapabilities.js';

type GradientRenderer = (text: string) => string;

interface BrandTheme {
  gradient: GradientRenderer;
  name: string;
  tagline: string;
}

const brandGradient: GradientRenderer = gradient(['#7c3aed', '#2563eb', '#06b6d4']);

export const brand: BrandTheme = {
  gradient: brandGradient,
  name: 'homie',
  tagline: 'open-source runtime for AI friends',
};

export const colors = {
  accent: '#7c3aed',
  info: '#2563eb',
  success: '#10b981',
  warn: '#f59e0b',
  error: '#ef4444',
  muted: '#6b7280',
  surface: '#1f2937',
} as const;

interface IconSet {
  thinking: string;
  streaming: string;
  inputCursor: string;
  done: string;
  attachment: string;
  toolRunning: string;
  toolDone: string;
  toolError: string;
  user: string;
  arrow: string;
  dot: string;
  command: string;
}

const cap = detectTerminalCapabilities(process.env);
export const icons: IconSet = cap.supportsUnicode
  ? {
      thinking: '◌',
      streaming: '▌',
      inputCursor: '▏',
      done: '●',
      attachment: '📎',
      toolRunning: '◎',
      toolDone: '✓',
      toolError: '✗',
      user: '›',
      arrow: '→',
      dot: '·',
      command: '/',
    }
  : {
      thinking: '*',
      streaming: '|',
      inputCursor: '|',
      done: '*',
      attachment: '[file]',
      toolRunning: '~',
      toolDone: 'ok',
      toolError: 'x',
      user: '>',
      arrow: '->',
      dot: '-',
      command: '/',
    };

export const formatBrand = (): string => brand.gradient(brand.name);

export const placeholderText = 'message...';

const toolLabels: Record<string, string> = {
  search_web: 'searching the web',
  web_search: 'searching the web',
  browse_url: 'reading a webpage',
  fetch_url: 'fetching a page',
  read_file: 'reading a file',
  write_file: 'writing',
  list_files: 'browsing files',
  execute_code: 'running code',
  run_command: 'running a command',
  shell: 'running a command',
  memory_search: 'searching memory',
  memory_store: 'remembering that',
};

export const friendlyToolLabel = (name: string): string =>
  toolLabels[name] ?? name.replace(/[_-]/gu, ' ');

export const friendlyPhase = (
  phase: string,
  elapsedMs: number,
  latestToolName?: string | undefined,
): string => {
  if (phase === 'tool_use' && latestToolName) return friendlyToolLabel(latestToolName);
  if (phase === 'streaming') return 'responding';
  if (elapsedMs > 30_000) return 'still waiting (this is slower than usual)';
  if (elapsedMs > 15_000) return 'waiting for backend';
  if (elapsedMs > 8_000) return 'still thinking';
  return 'thinking';
};
