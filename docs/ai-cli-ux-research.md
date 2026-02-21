# AI CLI UX Research: What Makes These Tools Feel "God Tier"

Comprehensive analysis of UX patterns across Claude Code, GitHub Copilot CLI, Cursor CLI, Aider, OpenAI Codex CLI, and the broader AI CLI ecosystem.

---

## 1. Rendering Architecture: The Big Picture

### Claude Code — React + Ink (TypeScript)
- **Stack**: React components rendered to terminal via [Ink](https://github.com/vadimdemedes/ink), using the Yoga layout engine (same flexbox engine as React Native) compiled to WASM via `yoga-layout-prebuilt`.
- **Virtual DOM for terminals**: React reconciliation + Yoga calculates character positions → ANSI output. Sub-millisecond layout, even during streaming.
- **Component architecture**: Declarative React components for messages, tool outputs, permission dialogs, input capture. Standard `useState`/`useEffect` hooks drive all state transitions.
- **Why it works**: Developers already know React. Declarative state management handles the *explosion* of concurrent UI states (streaming text + tool calls + permission prompts + spinners simultaneously) without spaghetti imperative code.

### OpenAI Codex CLI — Rust + Ratatui
- **Stack**: Rust TUI built on [Ratatui](https://ratatui.rs/) (the maintained fork of `tui-rs`).
- **ChatWidget**: Main surface that consumes protocol events, builds "transcript cells" (committed history) and a live "active cell" that mutates during streaming.
- **Transcript overlay** (`Ctrl+T`): Renders committed cells + live tail of current active cell, keeping in-flight tool calls visible.
- **Custom Terminal**: Derived from Ratatui's Terminal — frame-based rendering with explicit cursor positioning. Manages its own scrollback rather than relying on terminal-native scrollback.
- **Tradeoff**: Full TUI control means better UX for expandable history/conversation, but complicates standard copy/paste (requires `/toggle-mouse-mode` workaround).

### GitHub Copilot CLI — TypeScript + Ink
- Same Ink foundation as Claude Code.
- 6,000+ lines of TypeScript just for the animated ASCII banner — most handling terminal inconsistencies, not visuals.
- Custom frame-based animation system: frames stored as plain text, semantic color roles applied at runtime, themes as simple mappings.
- Animation loop: `setInterval` at ~75ms (~13fps) with `readline.cursorTo` + `readline.clearScreenDown` for frame replacement.

### Aider — Python, raw terminal
- Simpler approach: standard Python terminal output with real-time streaming diffs.
- Chat-based interface with `>` prompt.
- Leverages `rich` for markdown rendering and syntax highlighting.
- Multiple chat modes (`/code`, `/architect`, `/ask`, `/help`) to scope the UI to the task.

### Cursor CLI — TypeScript
- Three distinct modes (Agent/Plan/Ask) each optimized for different UI density.
- Progressive disclosure for security: sandbox by default → "Skip"/"Run"/"Add to allowlist" on failure.
- Cloud handoff: prepend `&` to push tasks to background, resume on web/mobile.

---

## 2. Streaming AI Output: The Core UX Problem

### The challenge
LLM responses arrive as a stream of tokens. The UI must:
1. Render incrementally without flickering
2. Handle partial markdown (unterminated code blocks, incomplete tables)
3. Show concurrent tool calls while text streams
4. Maintain scroll position and user context

### Claude Code's approach
- Ink re-renders on every state change → stream tokens into React state → Ink diffs and patches the terminal output.
- Yoga layout recalculates positions per update, but WASM compilation keeps it sub-millisecond.
- The "verbose mode" toggle (`Ctrl+O`) lets users control information density in real-time during streaming.
- Task list toggle (`Ctrl+T`) provides a structured overlay while content streams underneath.

### Codex CLI's approach
- Ratatui frame-based rendering: each "frame" is a complete terminal snapshot.
- Active cell mutates in-place during streaming; committed cells are immutable.
- Transcript overlay shows both committed history + live streaming content simultaneously.

### GitHub Copilot CLI's approach
- Users can send follow-up messages *while Copilot is thinking* (Shift+Tab for plan mode, real-time steering).
- Streaming responses render with improved markdown colors and diff display.
- 25% average reduction in response time, 45% median improvement through prompt optimization.

### Key Libraries for Streaming Markdown

| Library | Language | Weekly Downloads | Notes |
|---------|----------|-----------------|-------|
| **marked-terminal** | Node.js | 4.3M | marked renderer → ANSI. Syntax highlighting via cli-highlight, tables via cli-table3, chalk colors. 890 dependents. |
| **Streamdown** (Python) | Python | — | Real-time streaming markdown for terminals. Syntax highlighting, images (OSC 8), clipboard (OSC 52), plugin system. |
| **Streamdown** (React) | TypeScript | — | Vercel's react-markdown replacement. Handles incomplete/unterminated blocks, GFM, Shiki highlighting, LaTeX, Mermaid. 4.4K stars. |
| **Glamour** | Go | — | Stylesheet-based markdown rendering. Powers GitHub CLI, GitLab CLI, Gitea CLI. Auto dark/light detection. |
| **Glow** | Go | — | Terminal markdown reader built on Glamour. 22.8K stars. Pager, TUI browsing, file/URL/stdin support. |

---

## 3. Tool Call Visualization

### Claude Code
- Tools render as distinct visual blocks in the conversation stream.
- Tool types: `BashTool`, `FileReadTool`, `FileWriteTool`, `FileEditTool`, `GlobTool`, `GrepTool`, `AgentTool`, `MCPTool`, `ThinkTool`.
- Permission prompts interrupt the flow with an interactive dialog (approve/deny/always allow).
- Community HUD plugin shows running tool spinners: `⟳ Read src/index.ts` with elapsed time.
- Claude HUD updates every ~300ms via native statusline API.

### GitHub Copilot CLI
- Diffs shown by default during file editing (as of late 2025 update).
- Slash commands with hints and tab completion for discoverable actions.
- Planning mode renders a structured implementation plan before any tool execution.

### Codex CLI
- Transcript cells: each tool invocation becomes a "cell" in the conversation history.
- Active cell shows the in-flight tool call, expandable in the transcript overlay.
- Three approval modes: Read Only, Auto, Full Access — with OS-level sandboxing (macOS Seatbelt, Linux Landlock).

### Aider
- Real-time diff display as edits are made.
- Architect mode: two-model pipeline (architect proposes → editor applies) with the plan visible in the chat.
- Automatic git commits with generated messages surface the "what happened" clearly.

### Common patterns
1. **Tool calls as collapsible blocks** — show name + status by default, expand for details.
2. **Permission as interruption** — modal or inline approval before destructive actions.
3. **Running indicator** — spinner/icon next to active tool name.
4. **Result summarization** — tool output condensed for the conversation, full output available on expand.

---

## 4. Spinner / Loading / Thinking Patterns

### Libraries

| Library | Downloads/wk | Notes |
|---------|-------------|-------|
| **ora** | 46.9M | The standard. Clean minimalist design. `succeed()`, `fail()`, `warn()` status methods. |
| **cli-spinners** | 38.5M | 70+ pre-built spinner designs as JSON (interval + frames array). Framework-agnostic. |
| **ink-spinner** | 1.6M | React component for Ink. Wraps cli-spinners with `type` prop. |
| **nanospinner** | — | Lightweight alternative to ora. |

### Patterns observed

**Claude Code**:
- Status line at bottom shows context usage (green → yellow → red progress meter), active tool spinners, agent status + elapsed time, todo progress counters.
- Print mode (`-p`) currently lacks a loading indicator — a known gap that users have requested (comparing to `gum spin`).
- Verbose toggle (`Ctrl+O`) controls whether you see "thinking" details or just results.

**GitHub Copilot CLI**:
- Users can type follow-up messages while the model is "thinking" — the loading state is not a blocker.
- The animated ASCII banner plays during initialization (~3 seconds), masked as branding but doubling as a loading distraction.

**Codex CLI**:
- Active cell in the transcript shows streaming state.
- Approval modes eliminate unnecessary waiting for permissions in trusted contexts.

### Best practices
- **Purposeful animation**: Spinners should indicate *what* is happening, not just *that* something is happening. `⟳ Reading 3 files...` beats a bare spinner.
- **Non-blocking thinking**: Let users type or queue input while the model processes.
- **Progressive disclosure of thinking**: Default to compact, let users expand.
- **Elapsed time**: Always show how long a step has been running. Manages expectations.

---

## 5. Diff / Code Display Patterns

### In AI CLI tools
- **Claude Code**: FileEditTool shows old_string → new_string replacements. Syntax highlighting via Ink's text rendering. Diffs rendered inline in the conversation.
- **Copilot CLI**: Diffs shown by default during file editing (unified diff format). Improved markdown colors for readability.
- **Aider**: Real-time streaming diffs as the primary code output format. Supports both unified diff and "whole file" edit formats.
- **Codex CLI**: Transcript cells can contain diff-formatted content.

### Standalone diff tools
- **delta**: The gold standard for terminal diffs. Syntax highlighting, side-by-side view, word-level diff (Levenshtein), line numbers, hyperlinks. Uses bat themes.
- **colordiff**: Lightweight diff wrapper adding ANSI colors.

### Patterns
1. **Syntax-highlighted diffs** — not just red/green lines, but actual language-aware highlighting within the diff.
2. **Word-level highlighting** — show exactly which characters changed within a line, not just "this line changed."
3. **Context lines** — enough surrounding code to understand the change without opening the file.
4. **File path headers** — clear indication of which file is being modified.
5. **Collapsible by default** — show summary, expand for full diff.

---

## 6. Color Schemes & Theming

### The ANSI color problem
Terminals support three color depths:
- **4-bit**: 16 colors (the only safe ones for universal theming)
- **8-bit**: 256 colors (inconsistent rendering across terminals)
- **24-bit truecolor**: 16.7M colors (best visuals, worst portability)

### How the best tools handle it

**Claude Code**: Theme matching via `/config` command. Adapts syntax highlighting and UI chrome to terminal background.

**GitHub Copilot CLI**: Uses 4-bit ANSI palette mapped to semantic roles (not literal brand colors). Separate light/dark themes:
```
DARK:  { block_text: "cyan", eyes: "greenBright", head: "magentaBright", goggles: "cyanBright" }
LIGHT: { block_text: "blue", eyes: "green", head: "magenta", goggles: "cyan" }
```

**Gemini CLI**: Full custom theme configuration via YAML: `Background`, `Foreground`, `AccentBlue`, `AccentPurple`, `AccentCyan`, `AccentGreen`, `AccentYellow`, `AccentRed`, `Comment`, `Gray`.

### Design principles
1. **Semantic color roles, not literal values** — map "warning", "success", "accent" to ANSI codes, not hex values.
2. **Auto dark/light detection** — detect terminal background and switch themes. Glamour/Glow do this well.
3. **Graceful degradation** — design for 4-bit first, enhance for 256/truecolor.
4. **Respect user overrides** — high-contrast themes, custom palettes, accessibility settings must not break the UI.
5. **Minimal palette** — 4-6 colors maximum for primary UI. More causes visual noise.

---

## 7. Multi-Step Workflow Visualization

### Patterns across tools

**Claude Code**:
- Task list toggle (`Ctrl+T`) renders a structured todo list overlay.
- Statusline shows todo progress counters.
- Sub-agent delegation via `AgentTool` — tasks can be parallelized and their results aggregated.

**GitHub Copilot CLI**:
- Plan mode (Shift+Tab): Copilot asks clarifying questions → builds structured implementation plan → user approves → execution begins.
- Steps visible as a structured list before any code is written.

**Cursor CLI**:
- Three modes (Agent/Plan/Ask) provide explicit workflow phases.
- Session persistence: resume previous conversations to maintain multi-step context.
- Cloud handoff: background long tasks, pick up on other devices.

**Aider**:
- Architect mode: two-phase workflow (architect proposes → editor applies).
- Recommended workflow bounces between `/ask` (planning) and `/code` (execution).

### Common patterns
1. **Plan → Execute separation** — show users what will happen before doing it.
2. **Structured step lists** — numbered/bulleted plans with status indicators (pending/running/done/failed).
3. **Keyboard-togglable overlays** — don't replace the main view, layer on top.
4. **Progress counters** — "3/7 steps complete" in a persistent status area.

---

## 8. What Makes Claude Code's UX Specifically Excellent

1. **React mental model in the terminal**: Developers already understand React. Using Ink means the terminal UI is built with the same declarative patterns as web UIs — components, state, hooks, composition. This makes the codebase maintainable and the behavior predictable.

2. **Information density controls**: `Ctrl+O` (verbose), `Ctrl+T` (task list) let the user dynamically control how much they see. This is rare — most CLIs are fixed-density.

3. **Customizable statusline**: The bottom bar runs shell scripts to show context-at-a-glance (git branch, context window %, session cost). Configurable via natural language through `/statusline`. This is borrowed from vim/tmux culture and feels native to terminal power users.

4. **Multi-line input done right**: Four methods (Quick escape `\` + Enter, Option+Enter, Shift+Enter, paste detection) covering every terminal emulator. This tiny detail eliminates constant friction.

5. **Slash commands + keyboard shortcuts**: `/config`, `/statusline`, `/clear` etc. provide discoverable power. Combined with shortcuts, there's always a fast path.

6. **Permission UX**: Not just "allow/deny" but "allow for session"/"always allow"/"deny" with clear scope explanation. Makes the security model feel enabling rather than blocking.

7. **Theme matching**: Auto-adapts to the user's terminal theme rather than imposing its own aesthetic. Feels native.

8. **Cost tracking**: Session cost displayed in statusline. Unique to Claude Code and deeply practical for developers watching API spend.

9. **Sub-agent delegation**: `AgentTool` spawns independent agents for parallel tasks. The UI surfaces this as nested context without overwhelming the main conversation.

10. **Hooks system**: Pre/post execution hooks give power users escape hatches. The UI doesn't need to handle every edge case — users can wire in their own logic.

---

## 9. The "God Tier" Techniques Summary

### Architecture choices that compound

| Technique | Used By | Impact |
|-----------|---------|--------|
| React + Ink for terminal UI | Claude Code, Copilot CLI | Declarative state management for complex concurrent UI states |
| Ratatui (Rust) frame rendering | Codex CLI | Maximum performance, full TUI control, managed scrollback |
| Yoga/flexbox layout in terminal | Claude Code (via Ink) | CSS-like positioning without manual cursor math |
| Semantic color roles | Copilot CLI, Gemini CLI | Theme portability across dark/light/high-contrast terminals |
| WASM-compiled layout engine | Claude Code | Sub-ms layout even during rapid streaming updates |

### UX patterns that feel premium

| Pattern | Example | Why It Feels Good |
|---------|---------|------------------|
| Non-blocking input during thinking | Copilot CLI | Respects user's time; they're not waiting passively |
| Dynamic information density | Claude Code `Ctrl+O`/`Ctrl+T` | User controls the firehose |
| Plan-then-execute workflow | Copilot CLI Shift+Tab, Aider `/architect` | Builds trust before destructive actions |
| Persistent context status bar | Claude Code statusline | Ambient awareness without context-switching |
| Streaming diffs as primary output | Aider | See changes happen in real-time, builds confidence |
| Progressive permission disclosure | Cursor CLI sandbox → allowlist | Security doesn't feel like friction |
| Session persistence/resumption | Cursor CLI, Claude Code | Work survives terminal crashes |
| Tool calls as first-class UI elements | Claude Code, Codex CLI | Transparency into what the agent is *doing* |

### Libraries to build with (Node.js/TypeScript)

| Purpose | Library | Why |
|---------|---------|-----|
| Terminal UI framework | **ink** (React renderer) | Declarative, composable, flexbox layout |
| Markdown rendering | **marked** + **marked-terminal** | 4.3M downloads/wk, battle-tested |
| Syntax highlighting | **cli-highlight** or **Shiki** | Language-aware code coloring |
| Spinner/loading | **ora** or **ink-spinner** | Clean, 70+ animations, status methods |
| Spinner frames | **cli-spinners** | JSON-based, framework-agnostic |
| Colors | **chalk** | ANSI color abstraction, auto-detection |
| Diff display | **diff** + custom renderer | Or integrate delta-style word-level diffs |
| Tables | **cli-table3** | Used by marked-terminal |
| Layout engine | **yoga-layout-prebuilt** | Flexbox for terminal (comes with Ink) |
| Input handling | **ink** built-in + custom hooks | Multi-line, shortcuts, key capture |

---

## 10. Key Takeaways for homie

1. **Use Ink (React) for the terminal UI.** Claude Code and Copilot CLI both chose this. It's the right abstraction for handling concurrent streaming + tool calls + permission prompts.

2. **Render markdown with marked-terminal.** 4.3M weekly downloads, integrates with marked, handles syntax highlighting, tables, and emoji.

3. **Stream tokens into React state, let Ink handle the diffing.** Don't manually manage cursor positions for streaming output.

4. **Implement information density controls early.** A verbose toggle and a status overlay will pay dividends as the agent gets more capable.

5. **Use semantic color roles.** Map UI elements to roles ("accent", "success", "warning", "muted") and resolve to ANSI codes at runtime based on terminal capabilities.

6. **Show tool calls as first-class UI blocks.** Name + spinner while running, collapsible result when done.

7. **Plan-then-execute for multi-step operations.** Show the plan, get approval, then execute. Builds trust.

8. **Persistent status bar.** Git branch, context usage, cost, active tool — always visible at the bottom.

9. **Non-blocking input.** Let users type while the model thinks.

10. **Progressive permission model.** Start restrictive, make it easy to open up with "always allow" for trusted patterns.
