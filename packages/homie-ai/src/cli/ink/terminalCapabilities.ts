export interface TerminalCapabilities {
  supportsSynchronizedOutput: boolean;
  supportsUnicode: boolean;
  recommendedDeltaBatchMs: number;
}

type TerminalEnv = NodeJS.ProcessEnv & {
  LC_ALL?: string | undefined;
  LC_CTYPE?: string | undefined;
  LANG?: string | undefined;
  TERM_PROGRAM?: string | undefined;
  TERM?: string | undefined;
};

const isUnicodeLikelySupported = (env: TerminalEnv): boolean => {
  const parts = [env.LC_ALL, env.LC_CTYPE, env.LANG].filter(Boolean) as string[];
  return parts.some((p) => /utf-?8/iu.test(p));
};

const supportsSyncOutputByTerminal = (env: TerminalEnv): boolean => {
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();
  if (termProgram.includes('iterm') || termProgram.includes('wezterm')) return true;
  if (term.includes('xterm-kitty') || term.includes('ghostty') || term.includes('alacritty')) {
    return true;
  }
  return false;
};

export const detectTerminalCapabilities = (
  env: TerminalEnv = process.env as TerminalEnv,
): TerminalCapabilities => {
  const supportsSynchronizedOutput = supportsSyncOutputByTerminal(env);
  const supportsUnicode = isUnicodeLikelySupported(env);
  return {
    supportsSynchronizedOutput,
    supportsUnicode,
    // Slightly slower batching in less-capable terminals helps perceived stability.
    recommendedDeltaBatchMs: supportsSynchronizedOutput ? 18 : 28,
  };
};
