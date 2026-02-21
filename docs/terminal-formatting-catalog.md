# Bleeding-Edge Terminal Formatting & Rendering Catalog

> Compiled Feb 2026. Focused on Node.js/Bun ecosystem unless noted.

---

## 1. Markdown Rendering

Render full markdown documents directly in the terminal with syntax highlighting, tables, images, and emoji.

| Library | Version | Weekly DL | Notes |
|---------|---------|-----------|-------|
| **marked-terminal** | 7.3.0 | 4.3M | Custom renderer for `marked`. Syntax highlighting, tables, emoji. 890 dependents. Has open issues with marked v16+/v17+ peer deps. |
| **marked-terminal-renderer** | 2.2.0 | — | Released Dec 2025. Async support, image rendering (local + HTTP/S), light/dark themes, built-in `catmd` CLI, text wrapping, nested lists, blockquotes, task lists. Modern alternative. |
| **ink-markdown** | 1.0.4 | — | React component for Ink. Wraps `marked-terminal` with JSX interface. 55 dependents. |
| **glamour** (Go) | 0.10.0 | — | Charmbracelet's stylesheet-based markdown renderer. Gold standard for terminal markdown. No Node equivalent yet—gap in ecosystem. |

**Usage (marked-terminal):**
```ts
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
marked.use(markedTerminal());
console.log(marked.parse('# Hello\n**bold** and `code`'));
```

**Usage (marked-terminal-renderer):**
```ts
import { MarkedTerminalRenderer } from 'marked-terminal-renderer';
// Supports async image loading, theming, and more
```

---

## 2. Syntax Highlighting (Shiki)

TextMate-grammar-based highlighting with 200+ languages and VS Code themes, rendered to ANSI.

| Library | Notes |
|---------|-------|
| **@shikijs/cli** | Official Shiki CLI. `codeToANSI(source, lang, theme)` API. Themes: `vitesse-dark`, `nord`, `dracula`, etc. Aliases: `shiki`, `skat`. |
| **shiki** (core) | Programmatic API. Use `codeToAnsi()` for terminal output. Supports dual/multi-theme. |
| **shiki-command-line** | Community package with `highlightCode()` function. |

**Usage:**
```ts
import { codeToANSI } from '@shikijs/cli';
const highlighted = await codeToANSI(code, 'typescript', 'nord');
console.log(highlighted);
```

**Why over alternatives:** Shiki uses actual VS Code grammar files (TextMate), so highlighting is identical to VS Code. No regex approximation.

---

## 3. Inline Terminal Images

Display actual pixel images inside the terminal. Three competing protocols with varying support.

### Protocols

| Protocol | Terminals | Resolution |
|----------|-----------|------------|
| **Kitty Graphics Protocol** | Kitty, Ghostty, Konsole, WezTerm | Full pixel, alpha blending, animation |
| **iTerm Inline Image Protocol (IIP)** | iTerm2, WezTerm, Konsole, VSCode | Full pixel |
| **Sixel** | xterm, mlterm, foot, WezTerm, many others | 6px-high character cells |
| **ANSI block characters** | Any color terminal | ~2 pixels per character cell (▄▀ half-blocks) |

### Node Libraries

| Library | Protocol | Notes |
|---------|----------|-------|
| **terminal-image** | Auto-detect (Kitty/iTerm/fallback) | Sindresorhus. PNG, JPEG, animated GIF. Custom width/height. Best general choice. |
| **terminal-image-cli** | 4.0.0 | CLI wrapper. `npm i -g terminal-image-cli`. Updated Sep 2025. |
| **term-img** | 7.1.0 | iTerm IIP. Lower-level. Supports iTerm3+, WezTerm, Konsole, Rio, VSCode. |
| **sixel** | Sixel | WASM-based encode/decode. Stream support. |
| **@xterm/addon-image** | Sixel + IIP | For xterm.js. Up to 4096 color registers. |
| **img2ansi** | ANSI blocks | 24-bit color, animation, ~300ms processing. Works everywhere. |

**Usage (terminal-image):**
```ts
import terminalImage from 'terminal-image';
console.log(await terminalImage.file('logo.png', { width: '50%' }));
```

---

## 4. Unicode Box Drawing & Borders

Fancy boxes, panels, and frames using Unicode box-drawing characters (U+2500–U+257F).

| Library | Notes |
|---------|-------|
| **boxen** | Industry standard. Styles: `single` (┌─┐), `double` (╔═╗), `round` (╭─╮), `bold` (┏━┓), `singleDouble`, `doubleSingle`, `arrow`, `classic`, `none`. Titles, padding, margins, border colors, fixed dimensions, fullscreen. |
| **boxdraw** | Converts ASCII grid drawings (`+--+`) into Unicode box chars. Good for complex layouts. |
| **cli-box** | Lightweight. Custom marks for corners/edges. Text alignment. |

**Box-drawing character reference:**
```
Light:  ┌ ─ ┐ │ └ ┘ ├ ┤ ┬ ┴ ┼
Heavy:  ┏ ━ ┓ ┃ ┗ ┛ ┣ ┫ ┳ ┻ ╋
Double: ╔ ═ ╗ ║ ╚ ╝ ╠ ╣ ╦ ╩ ╬
Round:  ╭ ─ ╮ │ ╰ ╯
```

**Usage (boxen):**
```ts
import boxen from 'boxen';
console.log(boxen('unicorn', { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));
```

---

## 5. Terminal Hyperlinks (OSC 8)

Clickable links in terminal output, like `<a>` tags for the terminal.

| Library | Version | Weekly DL | Notes |
|---------|---------|-----------|-------|
| **terminal-link** | 5.0.0 | 15.1M | Sindresorhus. `terminalLink(text, url)`. Fallback for unsupported terminals. |
| **ansi-escapes** | 7.0.0+ | — | Lower-level. Raw OSC 8 sequences. Dependency of terminal-link. |
| **supports-hyperlinks** | 4.1.0+ | — | Detection library. Check before using OSC 8. |

**Terminal support:** iTerm2, GNOME Terminal, Alacritty, Kitty, WezTerm, Ghostty, VTE-based emulators. NOT macOS Terminal.app. Partial tmux support.

**Raw escape sequence:**
```
\e]8;;https://example.com\e\\Click here\e]8;;\e\\
```

**Usage (terminal-link):**
```ts
import terminalLink from 'terminal-link';
console.log(terminalLink('My Website', 'https://example.com'));
// Falls back to "My Website (https://example.com)" when unsupported
```

---

## 6. ANSI Art & Image-to-Text

Convert images to terminal-renderable ANSI art using 24-bit color and Unicode block characters.

| Library | Notes |
|---------|-------|
| **img2ansi** | 2025. 24-bit color, real-time processing, animation, video-to-terminal. ~300ms. Node + browser. |
| **terminal-image** | Higher-level, auto-detects best protocol. Falls back to ANSI blocks. |
| **ansilust** | Zig. Next-gen ANSI art renderer. Parses classic BBS-era formats + modern ANSI. 256-color and 24-bit RGB. Validated against 137+ real ANSI files. |

**Dispenser:** `curl https://textmode.cc/dispenser` for curated ANSI art pieces with 8-bit and 24-bit versions.

---

## 7. Gradient Text

Apply smooth color gradients across text using 24-bit (truecolor) ANSI sequences.

| Library | Version | Weekly DL | Notes |
|---------|---------|-----------|-------|
| **gradient-string** | 3.0.0 | 2.5M | Primary choice. Hex, RGB, named colors. Built-in presets: `rainbow`, `pastel`, `atlas`, `cristal`, `teen`, `mind`, `morning`, `vice`, `passion`, `fruit`, `instagram`, `retro`, `summer`. Multiline support. HSV/RGB interpolation. Custom color stops. |
| **chalk** | 5.x | — | 115K dependents. No gradients natively, but 24-bit color via `chalk.rgb(r,g,b)` and `chalk.hex('#ff0')`. Foundation layer. |
| **cfonts** | 3.3.1 | — | Large ASCII text with gradient support built-in. |
| **@TermStyle/core** | — | — | Zero-dep. Colors, gradients, animations, progress bars. |

**Usage (gradient-string):**
```ts
import gradient from 'gradient-string';
console.log(gradient.rainbow('This text has a rainbow gradient'));
console.log(gradient(['#ff0000', '#00ff00', '#0000ff'])('Custom gradient'));
console.log(gradient.pastel.multiline('Line 1\nLine 2\nLine 3'));
```

---

## 8. Rich Text Rendering (Python Rich Equivalents)

The Node ecosystem doesn't have a single "Rich for Node" yet. Instead, compose from these:

| Library | Role | Notes |
|---------|------|-------|
| **Ink** (v5) | React for terminals | 26.1K stars. Full React reconciler. Components, hooks, flexbox layout. The closest thing to Rich's compositor. |
| **neo-blessed** | ncurses in JS | Full terminal control. DOM-like widget API. CSR/BCE optimized rendering. Damage buffer diffing. |
| **@blessed/neo-blessed** | Maintained fork | Drop-in replacement for blessed. |
| **@dino-dna/react-tui** | React + neo-blessed | React reconciler on top of neo-blessed. |
| **cli-progress** | Progress bars | Multi-bar, presets, ETA, custom formatters. 3.5K dependents. |
| **chalk** + **gradient-string** | Text styling | Colors + gradients. |
| **marked-terminal** | Markdown | Renders markdown in terminal. |
| **@shikijs/cli** | Syntax highlighting | VS Code-quality highlighting. |
| **boxen** | Panels/boxes | Borders, padding, titles. |
| **cli-table3** | Tables | Cell spanning, alignment, word wrap. |

**Composition pattern for a "Rich-like" experience:**
```ts
// Combine Ink + Shiki + boxen + gradient-string + terminal-link
// for a compositor that rivals Python's Rich
```

---

## 9. SVG ↔ Terminal

Two directions: rendering SVGs *in* the terminal, and capturing terminal output *as* SVG.

### Terminal → SVG (Recording)

| Tool | Notes |
|------|-------|
| **@okhsunrog/svg-term-cli** | Maintained fork (2025). Renders asciicasts to animated SVG. `npm i -g @okhsunrog/svg-term-cli`. |
| **@jsenv/terminal-recorder** | Static SVG + animated GIF/MP4/WebM. Full ANSI + Unicode. |
| **termframe** | Rust. Executes commands, exports SVG screenshots. ANSI styles, font embedding, color themes. |
| **termsvg** | Record/play/export terminal sessions to animated SVG. Pause/resume. |

### SVG → Terminal

No direct high-quality library exists. Best approach:
1. Render SVG to PNG (sharp, puppeteer, resvg-js)
2. Display PNG via terminal-image / Kitty protocol / Sixel

---

## 10. Kitty Graphics Protocol (Advanced)

The most capable terminal graphics protocol. Supports arbitrary pixel graphics with alpha blending.

**Capabilities:**
- Transmit images as raw pixels, PNG, or compressed data
- Place at pixel-level positions within terminal cells
- Alpha blend with text and background
- Animate with frame-based updates
- Reference previously transmitted images by ID
- Unicode placeholders for text-flow integration

**Terminal support:** Kitty, Ghostty, Konsole, WezTerm, and growing.

**Node integration via terminal-image** auto-detects Kitty protocol.

**Applications using it:** MPV, Ranger, Yazi, fzf, Neovim (image.nvim), tmux (latest), Neofetch.

**Raw protocol (base64 PNG):**
```
\e_Gf=100,a=T,t=d;<base64-encoded-png>\e\\
```

---

## 11. Diff Rendering

Beautiful code diffs in the terminal.

| Tool/Library | Language | Notes |
|--------------|----------|-------|
| **difftastic** | Rust (CLI) | Structural diff using tree-sitter. Understands code syntax, not just lines. Gold standard for code diffs. |
| **diff2html** + **diff2html-cli** | Node | Git diff → HTML. Side-by-side view, syntax highlighting. 3.3K stars. |
| **ultraviolet** | Go (Charmbracelet) | Cell-based diffing algorithm. Minimal terminal writes. SSH-optimized. |
| **diff** (npm) | Node | `npm:diff`. Programmatic diff generation. Word, line, sentence, JSON diffs. Foundation layer. |

**For terminal-native diffs, combine:**
```ts
import { diffLines } from 'diff';
// + Shiki for syntax highlighting each side
// + chalk for red/green coloring
// + boxen for framing
```

---

## 12. Table Formatting

| Library | Version | Notes |
|---------|---------|-------|
| **cli-table3** | — | Actively maintained successor to cli-table/cli-table2. Cell spanning (row + col), per-cell styling, vertical alignment, word wrap, ANSI color support, truncation. Recommended. |
| **cli-table** | — | Original. Unmaintained. Unicode borders, color, alignment, padding. |
| **terminal-table** | — | Full-width char support. 3 border presets. Terminal-width fitting. Old (11yr). |
| **tty-table** | — | Another option with streaming support. |

**Usage (cli-table3):**
```ts
import Table from 'cli-table3';
const table = new Table({
  head: ['Name', 'Status', 'Score'],
  colWidths: [20, 15, 10],
  style: { head: ['cyan'], border: ['grey'] }
});
table.push(['Alice', '✓ Active', '98'], ['Bob', '✗ Inactive', '72']);
console.log(table.toString());
```

---

## 13. Terminal Animations

| Library | Version | Weekly DL | Notes |
|---------|---------|-----------|-------|
| **ora** | 9.3.0 | 55.9M | Feature-rich spinner. Prefix/suffix text, indent, cursor hiding, stdin discard. |
| **yocto-spinner** | 1.1.0 | 1.4M | Tiny alternative to ora. 1 dependency. Signal handling. Same author. |
| **nanospinner** | 1.2.2 | 1.2M | 15x smaller than ora. Success/error/warn/info states. Manual `.spin()` for custom loops. |
| **cli-spinners** | — | — | 70+ animation frame sets. Data-only, BYO renderer. |
| **chalk-animation** | — | 4.5K dependents | Text animations: `rainbow`, `pulse`, `glitch`, `radar`, `neon`, `karaoke`. Start/stop/replace control. Speed adjustment. |
| **cli-frames** | — | — | Custom frame arrays with configurable timing. Completion callbacks. |
| **@figliolia/chalk-animation** | — | — | Maintained TypeScript fork of chalk-animation. Updated Feb 2026. |

**Usage (chalk-animation):**
```ts
import chalkAnimation from 'chalk-animation';
const anim = chalkAnimation.neon('Loading...');
setTimeout(() => { anim.replace('Done!'); anim.stop(); }, 3000);
```

---

## 14. Braille Character Graphs & Sparklines

Unicode braille patterns (U+2800–U+28FF) give 2×4 pixel resolution per character cell—256 unique patterns.

| Library | Language | Notes |
|---------|----------|-------|
| **node-drawille** | Node | Port of Python drawille. Canvas API with braille rendering. 1K stars. |
| **drawille** | Python | Original. 3.1K stars. Pixel graphics via braille. |
| **asciichart** | Node | 1.5.25. Zero-dep. Line charts using ASCII. Simple but effective. 112 dependents. |
| **simple-ascii-chart** | Node | 5.3.1. TypeScript. Multi-series, custom colors, formatters. ESM+CJS. CLI tool + playground. More modern. |
| **SparkBraille** | Web | Interactive braille charts. Accessibility-focused. |

**Braille character resolution:**
```
Each braille cell = 2 columns × 4 rows = 8 dots
⠀ (empty) to ⣿ (full) = 256 combinations
Terminal: 80×24 chars → 160×96 "pixel" resolution with braille
```

**Usage (node-drawille):**
```ts
import { Canvas } from 'drawille';
const c = new Canvas(160, 160);
for (let i = 0; i < 360; i++) {
  const x = 80 + Math.cos(i * Math.PI / 180) * 70;
  const y = 80 + Math.sin(i * Math.PI / 180) * 70;
  c.set(Math.round(x), Math.round(y));
}
console.log(c.frame());
```

---

## 15. Ink Components & Ecosystem

Ink is React for the terminal. Here's the component ecosystem:

| Component | Notes |
|-----------|-------|
| **ink-markdown** | Markdown rendering via marked-terminal. |
| **ink-spinner** | Spinner component. |
| **ink-text-input** | Text input field. |
| **ink-select-input** | Select/dropdown component. |
| **ink-table** | Table component. |
| **ink-gradient** | Gradient text component. |
| **ink-big-text** | Large ASCII text (cfonts-based). |
| **ink-link** | Terminal hyperlinks (OSC 8). |
| **ink-image** | Inline images. |
| **ink-box** | Box/border component. |
| **ink-progress-bar** | Progress bar component. |
| **ink-task-list** | Task list with status indicators. |
| **ink-testing-library** | Testing utilities for Ink components. |

---

## Bonus: Large ASCII Text / Banners

| Library | Notes |
|---------|-------|
| **cfonts** | 3.3.1. Multiple fonts, ANSI colors, gradient support, alignment, spacing. 525 dependents. CLI + API. |
| **figlet** | 1.10.0. 1.9M weekly DL. FIGfont spec compliant. Hundreds of fonts. 13.4K dependents. |
| **figlet-cli** | CLI wrapper. Supports HTTP font URLs. |

**Usage (cfonts):**
```ts
import cfonts from 'cfonts';
cfonts.say('HOMIE', {
  font: 'block',
  align: 'center',
  gradient: ['red', 'blue'],
  transitionGradient: true,
});
```

---

## Bonus: Color Libraries (Foundation Layer)

| Library | Size | Weekly DL | Notes |
|---------|------|-----------|-------|
| **picocolors** | 6.4 KB | — | Tiniest. Fastest. Basic colors only. |
| **chalk** | 44 KB | — | 115K dependents. RGB/hex/HSL. Chaining API. Template literals. |
| **ansi-colors** | 26 KB | — | No dependencies. Faster than chalk v4. |
| **colorette** | 17 KB | — | Lightweight with auto-detection. |
| **Node.js `util.styleText`** | 0 KB | built-in | Node 21.7+. Native. No deps needed. `util.styleText('red', 'text')`. |

---

## Bonus: Terminal Capability Detection

| Library | Notes |
|---------|-------|
| **supports-color** | Detect color level (none/basic/256/truecolor). |
| **supports-hyperlinks** | Detect OSC 8 support. |
| **is-unicode-supported** | Detect Unicode support for fallback chars. |
| **is-interactive** | Detect if stdout is interactive (TTY). |
| **term-size** | Get terminal dimensions. |

---

## Bonus: Differential Rendering (Advanced)

Modern terminal apps use virtual-DOM-style diffing to minimize redraws:

| Framework | Notes |
|-----------|-------|
| **Ink** (Node) | React reconciler. Virtual DOM diffing. Flexbox layout. |
| **pi-tui** | Line-based diff with `2026` mode escape sequences for flicker-free updates. |
| **ultraviolet** (Go) | Cell-based diffing. SSH-optimized. Charmbracelet. |
| **rxtui** (Rust) | Virtual DOM with React-style component architecture. |

Claude Code (2025) reportedly uses: React scene graph → layout → rasterization → diffing → ANSI generation within ~16ms frame budget.

---

## Recommended Stack for a Stunning CLI

For a tool like homie that wants to look absolutely stunning:

### Foundation
- **picocolors** or **chalk** — color primitives
- **supports-color** + **supports-hyperlinks** + **is-unicode-supported** — capability detection with graceful fallback

### Text Styling
- **gradient-string** — gradient text for headers/banners
- **cfonts** — large ASCII banners with gradients
- **chalk-animation** — animated text for loading states

### Structured Content
- **boxen** — panels, callouts, framed content
- **cli-table3** — data tables with cell spanning
- **marked-terminal** or **marked-terminal-renderer** — markdown rendering

### Code Display
- **@shikijs/cli** (`codeToANSI`) — VS Code-quality syntax highlighting
- **diff** + Shiki + chalk — beautiful code diffs

### Visual Feedback
- **yocto-spinner** or **nanospinner** — lightweight spinners
- **cli-progress** — multi-bar progress
- **terminal-link** — clickable hyperlinks

### Advanced (Progressive Enhancement)
- **terminal-image** — inline images (auto-detects Kitty/iTerm/Sixel/fallback)
- **node-drawille** — braille-based sparklines and graphs
- **simple-ascii-chart** — ASCII line charts

### Framework Choice
- **Ink v5** — if building interactive/stateful UI (React paradigm)
- **Compose manually** — if building linear output (lighter weight)
