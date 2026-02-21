# Beautiful AI Chat TUI Catalog

Research into the best-looking terminal AI chat interfaces, their visual design
choices, and patterns worth borrowing.

---

## Tier 1: Best-in-Class Visual Design

### 1. Toad (by Will McGugan)

**Stack:** Python / Textual framework
**Stars:** New (Dec 2025) | **Status:** Active
**What it is:** Universal front-end for AI coding agents (OpenHands, Claude Code,
Gemini CLI) via Agent Client Protocol (ACP).

#### Conversation Layout
- Full-screen TUI with notebook-like block navigation
- Messages rendered as rich Markdown with syntax-highlighted code fences
- Cursor navigates block-by-block through conversation history (Jupyter-style)
- Inline shell output with full ANSI color, interactivity, and mouse support

#### Thinking/Loading States
- No specific spinner documented; focuses on streaming Markdown that renders
  incrementally without flicker
- Partial region updates (not full-screen redraws) keep the UI stable during
  generation

#### Color Scheme & Visual Treatment
- Deep, rich terminal palette inherited from Textual/Rich ecosystem
- Syntax highlighting inside streaming code fences, even before the fence closes
- Markdown tables, headers, lists all rendered with proper formatting

#### Spacing & Typography
- Clean padding between conversation blocks
- Rich text input area with Markdown highlighting as-you-type
- Mouse and keyboard selection in the prompt editor

#### Unique Patterns Worth Borrowing
- **Streaming Markdown without jank**: Renders incomplete code fences mid-stream
  using techniques from Will McGugan's streaming Markdown research
- **`@` fuzzy file search**: Brings file context into chat, filters `.gitignore`
- **Inline shell**: `!` prefix triggers shell mode; common commands auto-detected
- **Tab completion in prompt**: Borrows shell muscle memory (path/command
  completion)
- **Block-based scrollback**: Navigate through past conversation as discrete
  blocks, copy content, export to SVG
- **No flicker**: Precise partial-region updates vs. full screen rewrite

---

### 2. Elia (by Darren Burns)

**Stack:** Python / Textual framework
**Stars:** 2,425 | **Status:** Active
**What it is:** Keyboard-centric TUI for chatting with LLMs, stores conversations
in SQLite.

#### Conversation Layout
- Split-view design: sidebar with conversation list, main chat area
- Messages differentiated by role with clear visual boundaries
- Supports both full-screen and inline mode (`-i` flag renders under your prompt)

#### Thinking/Loading States
- Streaming token display as the model generates
- Textual framework handles incremental rendering

#### Color Scheme & Visual Treatment
- **9 built-in themes**: Nebula, Cobalt, Twilight, Hacker, Alpine, Galaxy,
  Nautilus, Monokai, Textual
- Custom theme support via YAML files with configurable:
  - `primary`, `secondary`, `accent` (for UI chrome)
  - `background`, `surface` (for depth layering)
  - `error`, `success`, `warning` (for status)
- Separate `message_code_theme` using Pygments themes (default: Monokai,
  supports Dracula, etc.)

#### Example Theme Definition (Galaxy)
```yaml
name: galaxy
primary: '#4e78c4'
secondary: '#f39c12'
accent: '#e74c3c'
background: '#0e1726'
surface: '#17202a'
error: '#e74c3c'
success: '#2ecc71'
warning: '#f1c40f'
```

#### Spacing & Typography
- Options panel accessible via `ctrl+o`
- Keyboard-first navigation throughout
- Multi-line input with configurable send key

#### Unique Patterns Worth Borrowing
- **Theme system architecture**: Simple YAML themes with semantic color tokens
  (primary/secondary/accent/surface) that map cleanly to terminal UIs
- **Inline mode**: `-i` flag renders the chat under your shell prompt instead of
  full-screen — great for quick questions
- **Dual code theming**: UI theme and code syntax theme configured separately
- **ChatGPT import**: Can import exported ChatGPT conversation JSON
- **Config via TOML**: Clean declarative config for models, themes, system
  prompts

---

### 3. Charm Mods (by Charm Bracelet) — SUNSETTING March 2026

**Stack:** Go / Bubble Tea + Lipgloss + Glamour
**Stars:** 4,476 | **Status:** Sunsetting (replaced by Crush)
**What it is:** AI for the command line, built for pipelines. Reads stdin,
processes with LLM, outputs formatted Markdown.

#### Conversation Layout
- Pipeline-oriented: not a persistent chat UI, but a single-shot
  stdin-to-LLM-to-stdout flow
- Conversation persistence via SHA-1 hashes and titles (like git commits)
- `--continue` / `--continue-last` flags to resume conversations

#### Thinking/Loading States
- **Gradient cycling character animation**: The standout visual feature
  - Random characters (`0-9a-fA-F~!@#$£€%^&*()+=_`) cycle at 22fps
  - Gradient ramp from `#F967DC` (pink) to `#6B50FF` (purple) applied per-char
  - Label text decrypts character-by-character (initial delay → random cycling →
    final value)
  - Ellipsis spinner appended after label text stabilizes
  - Color cycling: the gradient slides across characters at 5fps
  - TrueColor detection: falls back gracefully on limited terminals
  - Max 120 cycling characters

#### Color Scheme & Visual Treatment
- **17 distinct lipgloss style definitions** including:
  - `AppName`: Bold
  - `CyclingChars`: `#FF87D7` (hot pink)
  - `ErrorHeader`: White on `#FF5F87` (red), bold, padded
  - `Flag`: Adaptive `#00B594` (light) / `#3EEFCF` (dark), bold
  - `InlineCode`: `#FF5F87` on `#3A3A3A`, padded
  - `Link`: `#00AF87`, underlined
  - `Quote`: Adaptive `#FF71D0` / `#FF78D2`
  - `Pipe`: Adaptive `#8470FF` / `#745CFF`
  - `OutputHeader`: White on `#6C50FF` (purple), bold
- **Adaptive colors**: Light/dark variants detected via `termenv`
- **Glamour** for Markdown rendering with stylesheet-based theming
- `--theme` flag: `charm`, `catppuccin`, `dracula`, `base16`

#### Spacing & Typography
- `--word-wrap` defaults to 80 columns
- Horizontal edge padding of 2 chars
- Action confirmation labels: bold white-on-color badges (e.g., `WROTE`)

#### Unique Patterns Worth Borrowing
- **The gradient "decryption" animation**: The single most distinctive loading
  animation in any terminal AI tool. Characters scramble with random hex chars in
  a pink-to-purple gradient, then resolve to the status text. Feels like
  Hollywood hacking but tasteful.
- **Adaptive color system**: Every color has light/dark variants via
  `lipgloss.AdaptiveColor`
- **Action confirmation badges**: Bold text on colored background pills
  (ERROR, WROTE) — clear status communication
- **Pipeline-first design**: Works as a Unix tool (`cat file | mods "summarize"`)
  while also supporting interactive mode

---

### 4. Crush (by Charm Bracelet)

**Stack:** Go / Bubble Tea + Lipgloss + Glamour (Charm ecosystem)
**Stars:** 20,170 | **Status:** Very active (115+ releases, Feb 2026)
**What it is:** The successor to Mods. Full agentic coding assistant with
sessions, LSP integration, MCP support.

#### Conversation Layout
- Full TUI with session management (multiple sessions per project)
- Markdown-rendered responses via Glamour
- Tool call results displayed inline
- Permission prompts for tool execution (or `--yolo` to skip)

#### Thinking/Loading States
- Inherits Charm's animation library (likely evolved from Mods' gradient cycling)
- Streaming responses rendered progressively

#### Color Scheme & Visual Treatment
- Built on same Charm styling stack as Mods (Lipgloss, Glamour, termenv)
- Cross-platform terminal capability detection
- Markdown rendering with syntax highlighting

#### Spacing & Typography
- Compact mode available via `tui.compact_mode` config
- Word-wrapped output

#### Unique Patterns Worth Borrowing
- **Compact mode toggle**: `compact_mode` config for dense vs. spacious layouts
- **Permission UX**: Tool execution requires explicit approval with
  `allowed_tools` whitelist
- **Session architecture**: Multiple named sessions per project with context
  preservation across model switches
- **LSP integration for context**: Uses Language Server Protocol for code-aware
  suggestions, same way a human developer would
- **Attribution in commits**: Configurable `Assisted-by` / `Co-Authored-By`
  trailers

---

## Tier 2: Strong Design with Notable Features

### 5. oterm

**Stack:** Python / Textual framework
**Stars:** 2,320 | **Status:** Active
**What it is:** Terminal client specifically for Ollama (local models).

#### Conversation Layout
- Multi-session with sidebar navigation
- Chat bubbles/messages with visual distinction between user and model
- Image selection interface for multimodal conversations
- Splash screen animation on startup

#### Thinking/Loading States
- Supports "thinking" mode for models that support it (extended reasoning)
- Streaming with tool integration

#### Color Scheme & Visual Treatment
- Multiple built-in themes (dark default, customizable via config)
- Textual framework's CSS-like styling system

#### Unique Patterns Worth Borrowing
- **Splash screen animation**: Greeting animation on launch adds personality
- **Per-session parameter tuning**: Each chat can have different temperature,
  top_p, top_k, context length
- **Zero-config start**: Just `oterm` with no setup required
- **MCP sampling support**: Beyond just tools and prompts

---

### 6. AIChat (by sigoden)

**Stack:** Rust
**Stars:** 5,000+ | **Status:** Very active
**What it is:** All-in-one LLM CLI with REPL, shell assistant, RAG, agents.

#### Conversation Layout
- REPL-based conversation with configurable prompts
- Session management with visual distinction between session/non-session modes
- Tab autocompletion for commands and config keys

#### Thinking/Loading States
- Streaming token display

#### Color Scheme & Visual Treatment
- Custom theme system using `.tmTheme` files (TextMate/Sublime themes)
- Auto-detection of dark/light terminal background
- Separate dark.tmTheme / light.tmTheme support
- Syntax highlighting in code blocks

#### Spacing & Typography
- Configurable text wrapping: `no`, `auto`, or specific width
- `wrap_code` setting for code block wrapping behavior
- Emacs (default) or Vi keybindings

#### Unique Patterns Worth Borrowing
- **tmTheme integration**: Reuses TextMate/Sublime themes — massive existing
  library of color schemes
- **Dark/light auto-detect**: Reads terminal background and picks appropriate
  theme automatically
- **Shell assistant mode**: Natural language to shell command conversion inline
- **Role system**: Pre-configured system prompts (e.g., `--role shell` outputs
  only one-liners)
- **Macro support**: Scriptable interaction patterns

---

### 7. OpenAI Codex CLI

**Stack:** TypeScript / Ink (React for terminals)
**Stars:** High | **Status:** Active
**What it is:** Terminal coding assistant using OpenAI models, built with React/Ink.

#### Conversation Layout
- React component hierarchy:
  - `TerminalChat` (overall container)
  - `TerminalMessageHistory` (scrollable message list)
  - `TerminalChatResponseItem` (individual messages)
  - `TerminalChatInput` (input with command history)
- Full Ink-based layout with focus management

#### Thinking/Loading States
- **Custom "ball" spinner animation**:
  - 10 frames: `( ● )` → ball bounces left/right
  - 80ms frame interval (12.5fps)
  - Separate ellipsis animation cycling at 500ms
  - Elapsed seconds counter displayed alongside
- Distinct `TerminalChatInputThinking` component for the loading state
- Tab navigation and focus management during generation

#### Color Scheme & Visual Treatment
- Ink's built-in styling with `<Box>` and `<Text>` components
- Color props on text elements for role differentiation

#### Spacing & Typography
- Responsive layouts adapting to terminal width
- vim-style navigation (j/k for scrolling)
- Slash commands for actions

#### Unique Patterns Worth Borrowing
- **React component model for TUI**: Full React lifecycle, hooks, state
  management in the terminal
- **Ball spinner with elapsed time**: More playful than a standard spinner;
  the bouncing ball + elapsed seconds gives clear "working on it" feedback
- **Approval workflow**: Read-only → read-write → full access permission tiers
- **Character-by-character typing animation** in BubblyGPT variant

---

### 8. GPTUI

**Stack:** Python / Textual framework
**Stars:** Moderate | **Status:** Active
**What it is:** Full-featured conversational TUI with advanced features.

#### Conversation Layout
- **5-area layout**:
  1. Chat area (main conversation)
  2. Status area (response animations, notifications)
  3. Input area (chat content)
  4. Auxiliary area (internal AI communications)
  5. Control area (program state management)

#### Unique Patterns Worth Borrowing
- **Multi-zone layout**: Dedicating screen real estate to status/notifications
  separately from conversation
- **Real-time token monitoring**: Live token count display
- **Live parameter tuning**: Adjust temperature/etc. mid-conversation
- **Group chat mode**: Multiple models in one conversation

---

### 9. chaTTY

**Stack:** Go
**Stars:** New | **Status:** Active
**What it is:** Minimalist, fast terminal AI chat client.

#### Unique Patterns Worth Borrowing
- **Shell-like editing**: Arrow-key history navigation feels native to terminal
  users
- **Instant startup**: No Electron, no server; sub-100ms launch
- **Markdown rendering with syntax highlighting**: Via Charm's Glamour

---

## Cross-Cutting Design Patterns

### Message Differentiation
| Tool | User Messages | Assistant Messages |
|------|--------------|-------------------|
| Toad | Rich text input with Markdown preview | Streamed Markdown blocks |
| Elia | Visually bounded, right-context | Left-aligned, themed |
| Mods | stdin pipe input | Glamour-rendered Markdown |
| oterm | Chat bubbles | Chat bubbles (different style) |
| Codex CLI | Ink `<Box>` components | Ink components + tool output |

### Loading/Thinking Animation Taxonomy
| Tool | Animation Type | Framerate | Visual |
|------|---------------|-----------|--------|
| Mods | Gradient cycling chars | 22fps chars, 5fps color | `#F967DC` → `#6B50FF` gradient on random hex chars |
| Codex CLI | Bouncing ball | 12.5fps | `( ● )` bouncing + elapsed seconds |
| Elia | Streaming tokens | Realtime | Direct token render |
| oterm | Thinking mode | Realtime | Extended reasoning display |
| Generic | Braille spinner | ~10fps | `⢿⣻⣽⣾⣷⣯⣟⡿` cycling |
| Generic | Ellipsis | ~2fps | `...` cycling |

### Color Palette Comparison
| Tool | Primary Accent | Background | Approach |
|------|---------------|------------|----------|
| Mods | Hot pink `#FF87D7` / Purple `#6C50FF` | Terminal default | Adaptive light/dark |
| Elia (Galaxy) | Blue `#4e78c4` | Deep navy `#0e1726` | Themed with YAML |
| AIChat | Theme-dependent | Auto-detected | tmTheme files |
| Crush | Charm pink/purple palette | Terminal default | Lipgloss adaptive |

### Theme Architecture Approaches
1. **YAML tokens** (Elia): semantic names → hex values. Simple, custom.
2. **tmTheme files** (AIChat): reuses Sublime/TextMate ecosystem. Huge library.
3. **CSS-like** (Textual apps): Textual's TCSS for layout + Rich for rendering.
4. **Lipgloss adaptive** (Charm tools): programmatic light/dark with fallbacks.
5. **Named presets** (Mods): `charm`, `catppuccin`, `dracula`, `base16`.

---

## Key Takeaways for homie

### Must-Have Visual Elements
1. **Streaming Markdown rendering** with syntax highlighting (table stakes now)
2. **Adaptive dark/light** color detection
3. **Distinctive loading animation** (gradient cycling or bouncing ball, not just
   a plain spinner)
4. **Clear role differentiation** between user input and assistant output

### High-Impact Differentiators
1. **Inline mode** (Elia's `-i`): render under the prompt for quick questions
2. **Themed system** with semantic tokens (primary/surface/accent)
3. **Block-based scrollback** (Toad): navigate conversation as discrete blocks
4. **Action badges** (Mods): colored pills for status (`THINKING`, `DONE`,
   `ERROR`)
5. **Compact mode toggle** for information-dense workflows

### Animation Reference Implementation (Mods-style gradient cycling)
The most visually distinctive pattern across all tools researched:
```
1. Generate N characters (up to 120)
2. Each character: random from `0-9a-fA-F~!@#$£€%^&*()+=_`
3. Apply gradient ramp #F967DC → #6B50FF per character position
4. Cycle gradient position at 5fps for shimmer effect
5. Label text: random → final value transition (decryption effect)
6. Append ellipsis spinner after label resolves
7. Detect TrueColor support; degrade gracefully
```

### Animation Reference Implementation (Codex-style ball spinner)
Simpler but effective:
```
Frames: ( ● ), ( ● ), ( ● ), ( ● ), ( ●), ( ● ), ( ● ), ( ● ), ( ● ), (● )
Interval: 80ms
Plus: elapsed seconds counter
Plus: separate ellipsis at 500ms cycle
```
