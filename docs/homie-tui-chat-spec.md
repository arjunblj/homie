# Homie AI TUI Chat Interaction Spec

> Implementation-oriented specification for a best-in-class terminal chat experience. Focus: operator workflows, state clarity, tool transparency, and scriptability.

---

## 1. State Machine: Chat Lifecycle

### 1.1 Chat Phase States

```
                    ┌─────────────────┐
                    │     IDLE        │
                    │ (ready for input)│
                    └────────┬────────┘
                             │ user sends
                             ▼
                    ┌─────────────────┐
                    │   THINKING      │◄──────┐
                    │ (spinner, no ETA)│       │
                    └────────┬────────┘       │
                             │ first token   │ tool_use_start
                             ▼               │
                    ┌─────────────────┐     │
                    │   STREAMING     │──────┘
                    │ (text + cursor) │
                    └────────┬────────┘
                             │ tool_use_start
                             ▼
                    ┌─────────────────┐
                    │   TOOL_RUNNING  │
                    │ (tool spinner)  │
                    └────────┬────────┘
                             │ tool_result
                             ▼
                    ┌─────────────────┐     ┌─────────────────┐
                    │ AWAITING_APPROVAL│────►│ APPROVED/DENIED │
                    │ (permission UI) │     └────────┬────────┘
                    └─────────────────┘              │
                             │                        │
                             └────────────────────────┘
                                      │
                                      ▼
                             ┌─────────────────┐
                             │     DONE        │
                             │ (or ERROR)      │
                             └─────────────────┘
```

### 1.2 Type Definitions

```ts
/** Top-level chat phase. Exactly one active at a time. */
export type ChatPhase =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool_running'
  | 'awaiting_approval'
  | 'done'
  | 'error';

/** Sub-state when phase is 'awaiting_approval'. */
export type ApprovalSubstate =
  | { kind: 'prompting'; toolName: string; toolId: string }
  | { kind: 'resolved'; decision: 'approved' | 'denied' };

export interface ChatState {
  phase: ChatPhase;
  approvalSubstate?: ApprovalSubstate | undefined;
  /** Elapsed ms since phase entered (for thinking, streaming, tool_running). */
  phaseStartedMs: number;
  /** Last error message when phase === 'error'. */
  lastError?: string | undefined;
}
```

### 1.3 Transition Rules

| From | Event | To |
|------|-------|-----|
| `idle` | user sends message | `thinking` |
| `thinking` | first text token | `streaming` |
| `thinking` | tool_use_start | `tool_running` |
| `streaming` | tool_use_start | `tool_running` |
| `tool_running` | tool_result (auto-approved) | `streaming` or `thinking` |
| `tool_running` | tool_result (needs approval) | `awaiting_approval` |
| `awaiting_approval` | user approves/denies | `streaming` or `thinking` |
| any | message_stop | `done` → `idle` |
| any | error | `error` |
| any | user interrupt (Ctrl+C) | `idle` (partial preserved) |

### 1.4 Acceptance Criteria

- [ ] **AC-1.1** Only one phase is active at a time; no overlapping spinners.
- [ ] **AC-1.2** `phaseStartedMs` is set on every phase transition; elapsed time is derivable.
- [ ] **AC-1.3** Transition from `thinking` to `streaming` occurs on first text token, not on thinking_delta.
- [ ] **AC-1.4** `done` is transient: immediately transition to `idle` after commit.

---

## 2. State Machine: Tool Lifecycle

### 2.1 Tool Execution States

```
  queued ──► running ──► success
     │          │            │
     │          │            └──► (result summarized, block collapsed)
     │          │
     │          └──► failure ──► (error shown, block expandable)
     │          │
     │          └──► cancelled ──► (user/system interrupt)
     │
     └──► skipped (approval denied)
```

### 2.2 Type Definitions

```ts
export type ToolExecutionPhase =
  | 'queued'
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped';

export interface ToolInvocation {
  id: string;
  name: string;
  phase: ToolExecutionPhase;
  /** Partial or full args (streaming may deliver incrementally). */
  args: Record<string, unknown>;
  /** Populated when phase is success/failure. */
  result?: unknown;
  error?: string;
  startedMs: number;
  endedMs?: number;
  /** Tier for permission gating. */
  tier: 'safe' | 'restricted' | 'dangerous';
}

export interface ToolLifecycleState {
  /** Ordered list of invocations in current turn. */
  invocations: ToolInvocation[];
  /** Index of the currently running invocation, if any. */
  activeIndex: number | null;
}
```

### 2.3 Visual Mapping

| Phase | Icon | Label | Elapsed |
|-------|------|-------|---------|
| `queued` | ○ | (dim) | — |
| `running` | ⟳ | `Running {name}...` | `12.3s` |
| `success` | ✓ | `{name} done` | `340ms` |
| `failure` | ✗ | `{name} failed` | — |
| `cancelled` | ⊘ | `{name} cancelled` | — |
| `skipped` | ⊘ | `{name} skipped` | — |

### 2.4 Acceptance Criteria

- [ ] **AC-2.1** At most one tool is in `running` at a time.
- [ ] **AC-2.2** Elapsed time is shown for `running` and `success` phases.
- [ ] **AC-2.3** Tool blocks are collapsible; default: name + phase + elapsed.
- [ ] **AC-2.4** Expand shows full args (formatted) and result/error.

---

## 3. Keyboard Shortcuts and Mode Model

### 3.1 Input Modes

```ts
/** Primary input mode: determines what keys do. */
export type InputMode = 'compose' | 'command' | 'approval' | 'overlay';

/** Compose: normal chat input. Command: slash-command prefix. Approval: y/n/a. Overlay: task list, etc. */
```

### 3.2 Shortcut Map

| Key | Mode | Action |
|-----|------|--------|
| `Enter` | compose | Send message |
| `Ctrl+C` | any | Interrupt (preserve partial) or quit if idle |
| `Ctrl+O` | any | Toggle verbosity (compact ↔ verbose) |
| `Ctrl+T` | any | Toggle task/plan overlay |
| `Ctrl+R` | compose | Reverse search history (optional) |
| `Ctrl+E` | compose | Open external editor (optional) |
| `/` | compose | Enter command mode |
| `Escape` | command/overlay | Return to compose |
| `y` / `n` / `a` | approval | Approve / Deny / Always allow |
| `Ctrl+U` | compose | Clear input line |

### 3.3 Slash Commands (Command Mode)

| Command | Action |
|---------|--------|
| `/exit` | Quit session |
| `/clear` | Clear scrollback (history persists) |
| `/verbose` | Toggle verbosity |
| `/plain` | Switch to plain output mode |
| `/json` | Switch to JSON output mode |
| `/model` | Show/set model (if configurable) |

### 3.4 Type Definitions

```ts
export interface ShortcutConfig {
  interrupt: string;      // default 'ctrl+c'
  verbosity: string;     // default 'ctrl+o'
  overlay: string;       // default 'ctrl+t'
  clearInput: string;    // default 'ctrl+u'
}

export interface ModeState {
  inputMode: InputMode;
  verbosity: 'compact' | 'verbose';
  outputFormat: 'tui' | 'plain' | 'json';
  overlayVisible: boolean;
}
```

### 3.5 Acceptance Criteria

- [ ] **AC-3.1** Ctrl+C during generation: interrupt, preserve partial response, return to compose.
- [ ] **AC-3.2** Ctrl+C when idle: exit process.
- [ ] **AC-3.3** Ctrl+O toggles verbosity; persists for session.
- [ ] **AC-3.4** Typing `/` enters command mode; Escape returns to compose.
- [ ] **AC-3.5** In approval mode, only y/n/a are valid; others ignored.

---

## 4. Status Line Design

### 4.1 Information Hierarchy

Priority order (left → right, most important first):

1. **Context** — Model name, context usage (if available)
2. **Activity** — Current phase label + elapsed
3. **Session** — Turn count, cost (if applicable)
4. **Hints** — Shortcut hints (e.g. `ctrl+c quit`)

### 4.2 Layout Specification

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [model] · [phase] [elapsed] · [turns] · ctrl+c quit                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Compact (default):**
```
homie · 3 turns · ctrl+c quit
```

**Active (thinking/streaming/tool):**
```
claude-3-5-sonnet · thinking 2.1s · 3 turns · ctrl+c quit
```

**With context usage (verbose):**
```
claude-3-5-sonnet · 42% context · streaming 1.2s · 3 turns · ctrl+c quit
```

### 4.3 Type Definitions

```ts
export interface StatusLineData {
  modelLabel: string;
  phase: ChatPhase;
  phaseElapsedMs?: number;
  contextUsedPct?: number;
  turnsCompleted: number;
  /** Optional: cost this session (e.g. MPP). */
  sessionCost?: string;
}

export interface StatusLineConfig {
  showContextUsage: boolean;
  showCost: boolean;
  showShortcutHints: boolean;
}
```

### 4.4 Semantic Tokens (from terminal-ux-design-system)

| Element | Token | Example |
|---------|-------|---------|
| Separator | `text.muted` | `·` |
| Phase label | `status.info` | `thinking` |
| Elapsed | `text.muted` | `2.1s` |
| Context bar | `status.success` → `status.warning` → `status.error` | Green → yellow → red by % |
| Hints | `text.muted` | `ctrl+c quit` |

### 4.5 Acceptance Criteria

- [ ] **AC-4.1** Status line is always visible at bottom; does not scroll with content.
- [ ] **AC-4.2** Phase + elapsed update at most every 100ms (debounce).
- [ ] **AC-4.3** Context usage (if available) uses color gradient: green &lt; 70%, yellow 70–90%, red &gt; 90%.
- [ ] **AC-4.4** When `outputFormat === 'plain'`, status line is suppressed.

---

## 5. Message Rendering Spec

### 5.1 Message Types

```ts
export type MessageRole = 'user' | 'assistant' | 'meta' | 'tool';

export interface BaseMessage {
  id: string;
  role: MessageRole;
  timestampMs: number;
}

export interface UserMessage extends BaseMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  content: string;
  isStreaming: boolean;
  /** Inline tool blocks (in order). */
  toolBlocks?: ToolInvocation[];
}

export interface MetaMessage extends BaseMessage {
  role: 'meta';
  content: string;
  /** Optional: error, react, system. */
  kind?: 'error' | 'react' | 'system';
}

export type ChatMessage = UserMessage | AssistantMessage | MetaMessage;
```

### 5.2 History vs Active Stream

| Region | Content | Behavior |
|--------|---------|----------|
| **History** | Committed messages | Rendered via `<Static>`; no re-render on stream |
| **Active stream** | Current assistant message | Live-updated; cursor when streaming |
| **Input** | User input buffer | Below active stream when idle |

### 5.3 Meta Events

| Kind | Visual | Example |
|------|--------|---------|
| `error` | `status.error` + icon | `✗ error: Connection timed out` |
| `react` | `text.muted` | `· reacted with 👍` |
| `system` | `text.muted` | `· context compacted` |
| (default) | `text.muted` | `· {content}` |

### 5.4 Tool Block Rendering

**Collapsed (default):**
```
┌ 🔧 read_url
│   ✓ 245 lines (340ms)
└
```

**Expanded:**
```
┌ 🔧 read_url
│   path: "src/index.ts"
│   ✓ Read 245 lines
│   ---
│   [result preview or full content]
└
```

### 5.5 Streaming Cursor

- **Symbol:** `▌` (block cursor) or `_` (ASCII fallback)
- **Blink:** 530ms (standard terminal blink) when `isStreaming`
- **Hide system cursor** during streaming to avoid double-cursor

### 5.6 Acceptance Criteria

- [ ] **AC-5.1** History uses `<Static>`; new messages append without re-rendering prior content.
- [ ] **AC-5.2** Active stream shows cursor only when `isStreaming` and `content.length > 0`.
- [ ] **AC-5.3** Meta messages use `kind` for semantic styling.
- [ ] **AC-5.4** Tool blocks are collapsible; collapsed by default after completion.
- [ ] **AC-5.5** Markdown in assistant content: incremental parse of last block only.

---

## 6. Error, Interrupt, and Retry UX

### 6.1 Error Handling

| Scenario | UX | Recovery |
|----------|-----|----------|
| Network error | Inline meta message + status line hint | User can retry (re-send) |
| Context overflow | Meta: "context full, compacting" | Auto-retry once |
| Model error | Meta: "model error: {message}" | User can retry |
| Tool execution error | Tool block: ✗ + error text | Expand for details; user can re-send |

### 6.2 Interrupt (Ctrl+C)

1. **During generation:** Abort in-flight request; preserve partial text in history.
2. **During tool run:** Abort tool (signal); mark tool as `cancelled`.
3. **When idle:** Exit process.

**Copy:** "Interrupted. Partial response preserved. You can reply to continue."

### 6.3 Retry

- **Explicit:** User re-sends same or edited message.
- **No automatic retry** for transient errors (avoids surprise loops).
- **Optional:** `/retry` slash command to re-send last user message.

### 6.4 Type Definitions

```ts
export interface ErrorState {
  kind: 'network' | 'model' | 'context' | 'tool';
  message: string;
  recoverable: boolean;
  occurredMs: number;
}
```

### 6.5 Acceptance Criteria

- [ ] **AC-6.1** Ctrl+C during generation: partial response committed to history; return to idle.
- [ ] **AC-6.2** Errors surface as meta messages; never raw stack traces to user.
- [ ] **AC-6.3** Every error message ends with actionable hint (e.g. "Check network, then retry").
- [ ] **AC-6.4** Tool errors appear in tool block, not as global meta.

---

## 7. Permission and Trust UX for Tools

### 7.1 Approval Modes

```ts
export type ApprovalMode = 'untrusted' | 'on_request' | 'never';

/** untrusted: prompt for restricted+dangerous. on_request: prompt for dangerous. never: no tools (CI). */
```

### 7.2 Permission Prompt

When a tool requires approval:

```
┌ Allow read_file?
│   path: "src/config.ts"
│   tier: restricted
│
│   [y] Allow  [n] Deny  [a] Always allow
└
```

### 7.3 Scope and Persistence

| Choice | Scope | Persistence |
|--------|-------|-------------|
| `y` (Allow) | This invocation | Session only |
| `n` (Deny) | This invocation | — |
| `a` (Always) | This tool name | Config file (e.g. `~/.config/homie/allowlist.json`) |

### 7.4 Type Definitions

```ts
export interface ToolApprovalRequest {
  toolId: string;
  toolName: string;
  tier: 'restricted' | 'dangerous';
  args: Record<string, unknown>;
}

export interface ApprovalConfig {
  mode: ApprovalMode;
  allowlist: string[];  // tool names
  allowlistPath: string;
}
```

### 7.5 Copy Guidelines

- **Avoid:** "Never share your key", "Danger!"
- **Prefer:** "This tool can read files. Allow for this session?"
- **Scope:** Be specific: "Read src/**" not "Access filesystem"

### 7.6 Acceptance Criteria

- [ ] **AC-7.1** `safe` tools never prompt; `restricted`/`dangerous` per mode.
- [ ] **AC-7.2** Approval prompt shows tool name, tier, and key args.
- [ ] **AC-7.3** `a` (Always) persists to allowlist; survives restart.
- [ ] **AC-7.4** `never` mode: tools disabled; show message on first tool attempt.

---

## 8. Verbosity Controls

### 8.1 Compact vs Verbose

| Aspect | Compact | Verbose |
|--------|---------|---------|
| Thinking | Spinner only | Spinner + "Thinking... (N chars)" |
| Tool blocks | Name + status | Full args + result preview |
| Meta events | Minimal | All system events |
| Status line | Phase + turns | + context %, cost |
| Errors | One line | Stack trace (sanitized) |

### 8.2 Toggle

- **Ctrl+O** at runtime
- **`--verbose`** / **`-v`** at launch
- **`/verbose`** slash command

### 8.3 Acceptance Criteria

- [ ] **AC-8.1** Default is compact.
- [ ] **AC-8.2** Verbose never shows raw internal paths or tokens.
- [ ] **AC-8.3** Toggle takes effect immediately (no restart).

---

## 9. Plain / JSON Output Fallback

### 9.1 Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| `tui` | Default | Full Ink TUI |
| `plain` | `--plain` / `-p` / `NO_COLOR` / `TERM=dumb` | No ANSI, one record per line |
| `json` | `--json` | NDJSON to stdout |

### 9.2 Plain Mode Format

```
user: hello
assistant: hi there
meta: reacted with 👍
user: /exit
```

- One message per line.
- Prefix: `user:`, `assistant:`, `meta:`, `tool:`.
- No colors, no box-drawing.

### 9.3 JSON Mode Format (NDJSON)

```json
{"role":"user","content":"hello","timestampMs":1708362000000}
{"role":"assistant","content":"hi there","timestampMs":1708362001000}
{"role":"meta","content":"reacted with 👍","kind":"react"}
```

### 9.4 Detection Order

1. Explicit `--plain` / `--json` flag
2. `NO_COLOR=1` → plain
3. `TERM=dumb` → plain
4. `!process.stdout.isTTY` → plain
5. Default → tui

### 9.5 Acceptance Criteria

- [ ] **AC-9.1** `--plain` produces grep/awk-friendly output.
- [ ] **AC-9.2** `--json` produces valid NDJSON; one object per line.
- [ ] **AC-9.3** When plain/json: no Ink render, no status line, no interactive input (read from stdin or `--input`).
- [ ] **AC-9.4** Pipe to `jq` works for JSON mode.

---

## 10. Implementation Checklist

| Area | Priority | Notes |
|------|----------|-------|
| Chat state machine | P0 | Replace current `ChatPhase` with full spec |
| Tool lifecycle types | P0 | Add `ToolInvocation` to engine/CLI boundary |
| Status line hierarchy | P1 | Implement `StatusLineData` |
| Keyboard shortcuts | P1 | useInput handlers for Ctrl+O, Ctrl+C |
| Message rendering | P1 | Static + active stream separation |
| Error UX | P1 | Meta messages, no stack traces |
| Approval flow | P2 | When tools require gating |
| Verbosity toggle | P2 | Compact/verbose state |
| Plain/JSON fallback | P2 | Flag detection, output format |

---

*Spec version: 1.0. References: terminal-ux-design-system.md, streaming-terminal-patterns.md, ai-cli-ux-patterns-research.md, mpp-onboarding-pattern-library.md.*
