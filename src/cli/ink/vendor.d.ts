declare module 'marked-terminal' {
  export function markedTerminal(
    options?: Record<string, unknown>,
    highlightOptions?: Record<string, unknown>,
  ): Record<string, unknown>;
}

declare module 'gradient-string' {
  type GradientFunction = (text: string) => string;
  interface GradientModule {
    (colors: string[]): GradientFunction;
    rainbow: GradientFunction;
    pastel: GradientFunction;
    cristal: GradientFunction;
    atlas: GradientFunction;
  }
  const gradient: GradientModule;
  export default gradient;
}

declare module 'terminal-link' {
  interface TerminalLinkOptions {
    fallback?: ((text: string, url: string) => string) | undefined;
  }
  function terminalLink(text: string, url: string, options?: TerminalLinkOptions): string;
  export default terminalLink;
}
