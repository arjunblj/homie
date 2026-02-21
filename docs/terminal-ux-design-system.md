# Terminal UX Design System: Command-Driven Delight

> Modern best practices (2025–2026) for command-driven terminal experiences. Focus: progressive disclosure, status/confidence, tool execution, long-running ops, accessibility, rendering quality, and human factors.

---

## 1. Design System: Tokens, Primitives, Components

### 1.1 Color Tokens (Semantic Roles)

Map UI elements to **semantic roles**, not literal hex values. Resolve to ANSI at runtime based on terminal capabilities.

| Token | Role | 4-bit ANSI | Use |
|-------|------|------------|-----|
| `text.primary` | Default content | default | Body text |
| `text.muted` | Secondary | dim/gray | Timestamps, hints |
| `text.accent` | Emphasis | cyan/blue | Links, highlights |
| `status.success` | Success | green | ✓ done, pass |
| `status.warning` | Caution | yellow | Warnings |
| `status.error` | Failure | red | Errors, fail |
| `status.info` | Informational | blue | Tips, info |
| `border.default` | Structure | dim | Boxes, separators |
| `border.focus` | Active | cyan | Focused element |

**Rules:**
- Design for 4-bit first; enhance for 256/truecolor.
- Auto dark/light detection where possible (Glamour/Glow pattern).
- Respect `NO_COLOR`, `--no-color`, `TERM=dumb`, non-TTY.
- Minimal palette: 4–6 primary colors max.

### 1.2 Typography Primitives

| Primitive | ANSI | Use |
|-----------|------|-----|
| `bold` | `\e[1m` | Headings, emphasis |
| `dim` | `\e[2m` | Muted, secondary |
| `italic` | `\e[3m` | Sparingly; poor terminal support |
| `underline` | `\e[4m` | Links (OSC 8 preferred) |

### 1.3 Symbol Tokens (with Fallbacks)

| Concept | Unicode | ASCII fallback | Use |
|---------|---------|----------------|-----|
| Success | ✓ / ✅ | `[OK]` | Completed, pass |
| Failure | ✗ / ❌ | `[FAIL]` | Error, reject |
| Warning | ⚠ | `[WARN]` | Caution |
| Running | ⟳ / ⠋ | `...` | In progress |
| Pending | ○ | `-` | Queued |
| Info | ℹ / 💡 | `[i]` | Hint |
| Cursor | ▌ | `_` | Streaming indicator |

**Accessibility:** Detect `is-unicode-supported`; use ASCII fallbacks when Unicode fails. Avoid emoji-only semantics—pair with text.

### 1.4 Component Primitives

| Component | Structure | Notes |
|-----------|-----------|-------|
| **Status line** | `[icon] label [elapsed]` | Bottom bar, ambient awareness |
| **Tool block** | `┌ icon name\n│ args...\n└ status` | Box-drawing for hierarchy |
| **Progress** | Spinner / X of Y / Bar | See §4 |
| **Message** | `[severity] text` | Errors, success, info |
| **Diff** | `- old` / `+ new` | Red/green, word-level |
| **Table** | `cli-table3` style | Headers, alignment |

---

## 2. Interaction States and Transitions (State Machine)

### 2.1 Agent/Turn State Machine

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
                    │  AWAITING_APPROVAL│────►│   APPROVED /    │
                    │ (permission prompt)│    │   DENIED        │
                    └─────────────────┘     └────────┬────────┘
                                                      │
                             ┌────────────────────────┘
                             ▼
                    ┌─────────────────┐
                    │     DONE        │
                    │ (or ERROR)      │
                    └─────────────────┘
```

### 2.2 Tool Execution States

| State | Visual | Transition |
|-------|--------|------------|
| `queued` | ○ dim | Tool scheduled |
| `running` | ⟳ + label + elapsed | Execution started |
| `success` | ✓ + summary | Completed |
| `failure` | ✗ + error | Failed |
| `cancelled` | ⊘ dim | User/system cancelled |

### 2.3 State Transition Rules

1. **One active state at a time** — no overlapping spinners.
2. **Elapsed time always visible** in running states (manages expectations).
3. **Non-blocking input** — allow typing while thinking (Copilot pattern).
4. **Interruption recovery** — Ctrl+C clears cleanly; offer "resume" if session persists.

---

## 3. Copywriting Guidance: Terse but Confident

### 3.1 Principles

| Principle | Do | Avoid |
|-----------|----|-------|
| **Conciseness** | "Can't connect to DB" | "Unable to establish connection to the SQL database" |
| **Active voice** | "unable to..." | "failed to..." (sounds passive) |
| **Logical actions** | "Resource isn't in cluster" | "The resource was not found and cannot be differentiated" |
| **Lowercase, no period** | "config missing" | "Config missing." |
| **One clear line** | Single error line | Long lists of alternatives (spam in scripts) |

### 3.2 Tense Discipline

- **During action:** gerund — "Downloading...", "Reading file..."
- **After completion:** past / present perfect — "Downloaded", "Read 245 lines"
- **Evil Martians:** "Don't skip updating status messages from `ing`'s to `ed`'s."

### 3.3 Error Message Structure

```
[What happened] [Why it matters]. [What to do next].
```

Examples:
- `Can't write to file.txt. Make it writable: chmod +w file.txt`
- `MPP_PRIVATE_KEY missing. Set it in .env (see .env.example)`
- `Connection timed out. Check network, then retry.`

### 3.4 Success Messages

- **Silence is valid** — exit 0, no output (like `cp`).
- **When state changes:** one-line confirmation. "Created project at ./my-app"
- **Avoid:** "Success!" or "Done!" without substance.

### 3.5 Confidence Indicators

| Scenario | Copy |
|----------|------|
| High confidence | "Found 12 matches" |
| Low/uncertain | "Found ~12 matches (fuzzy)" |
| Partial | "3 of 7 steps complete" |
| Retry | "Retrying... (attempt 2/3)" |

---

## 4. Long-Running Operation UX

### 4.1 Pattern Selection

| Duration | Pattern | Example |
|----------|---------|---------|
| Unknown, <5s | Spinner | `⠋ Thinking...` |
| Unknown, >5s | Spinner + elapsed | `⠋ Reading files... 12.3s` |
| Known total | X of Y | `Processing 7/23 files` |
| Known total, parallel | Progress bar(s) | `████████░░ 80%` |
| Multiple similar tasks | Single aggregate bar | One bar for "Downloading 5 libs" |

### 4.2 Spinner Best Practices

- **Purposeful:** `⟳ Reading src/index.ts` beats bare spinner.
- **Tick on completion:** Update when a unit of work finishes (signals "not stuck").
- **Clear when done:** Remove spinner from final output; leave clean log.

### 4.3 Progress Bar Rules

- **Don't overuse** — single task: X of Y often enough.
- **ETA when feasible** — "ETA 2m" or "~30s left".
- **Pause/resume** — support where possible (alive-progress, progressor).
- **Cancellation** — Ctrl+C returns to prompt; background if applicable.

### 4.4 Log Hygiene

- Green + ✓ for success lines.
- Red + ✗ for failures.
- Respect `--quiet` / `-q` for scripts.
- No animations when `!isTTY` (CI logs).

---

## 5. Accessibility in Terminal UIs

### 5.1 Contrast

- **WCAG:** 86%+ of pages have contrast issues; terminals are no exception.
- **Minimum:** 4.5:1 for normal text, 3:1 for large.
- **Test:** Use `supports-color` to detect level; avoid low-contrast grays on gray.

### 5.2 Symbols and Fallbacks

- **Never symbol-only** — pair ✓ with "done", ✗ with "failed".
- **ASCII fallbacks** when `!isUnicodeSupported` or user preference.
- **Screen readers:** They read character cells; structure via spacing, indentation, capitalization.

### 5.3 Color Independence

- **Don't rely on color alone** — use symbols + text for status.
- **High-contrast mode:** Respect `NO_COLOR`, `--no-color`; layout must still work.

### 5.4 Reduced Motion

- **Respect `REDUCED_MOTION`** — static indicators instead of spinners when set.
- **Blink rate:** Standard cursor blink ~530ms; avoid faster.

---

## 6. Markdown / Code / Diff Rendering

### 6.1 Streaming Markdown

- **Only last block can change** — parse incrementally, finalize completed blocks.
- **Incomplete syntax:** Temporarily close for render (`**bold` → `**bold**`).
- **Libraries:** marked-terminal, streamdown, ink-markdown.

### 6.2 Code Display

- **Syntax highlighting:** Shiki (TextMate grammars) > regex-based.
- **Collapsible by default** — show summary, expand for full.

### 6.3 Diff Quality

- **Word-level** — delta, difftastic; not just line-level.
- **Syntax-highlighted diffs** — language-aware within +/- lines.
- **File path headers** — clear which file changed.
- **Context lines** — enough to understand without opening file.

---

## 7. Human Factors: Cognitive Load, Interruption, Errors

### 7.1 Cognitive Load

- **Progressive disclosure** — compact by default, verbose on demand (Ctrl+O).
- **Chunk advanced options** — one "advanced" affordance, not many.
- **Max 2 disclosure levels** — tertiary gets lost.

### 7.2 Interruption Recovery

- **Ctrl+C** — always works; clean exit.
- **Session persistence** — resume after crash (Cursor, Claude Code).
- **Clear state** — "Session saved. Run `homie` to resume."

### 7.3 Error Clarity

- **Signal-to-noise** — one error line > wall of hints.
- **Group similar errors** — single header + list.
- **Put important info last** — eye drawn to end.
- **Actionable** — every error suggests a fix.

---

## 8. Guardrails: Avoiding Noisy/Cluttered UIs

### 8.1 Density Controls

| Control | Default | Effect |
|---------|---------|--------|
| `--verbose` / `-v` | Off | More detail |
| `Ctrl+O` (runtime) | Compact | Toggle thinking/details |
| `Ctrl+T` (runtime) | Off | Task list overlay |
| `--quiet` / `-q` | Off | Minimal output |

### 8.2 Anti-Patterns

| Avoid | Prefer |
|-------|--------|
| Multiple spinners | One active indicator |
| Walls of debug by default | Debug only in `-d` |
| Emoji everywhere | Semantic symbols, sparse emoji |
| Progress bars for single quick task | Spinner or nothing |
| Verbose success messages | Silence or one line |
| Color on everything | Semantic color only |

### 8.3 Pipeline / Script Hygiene

- **stdout** = primary output, machine-readable when piped.
- **stderr** = messages, errors, progress.
- **`--plain`** = no ANSI, one record per line for grep/awk.
- **`--json`** = structured output for automation.

---

## 9. Chat + Tool-Calling Agent: Specific Recommendations

### 9.1 Tool Call Visualization

- **Collapsible blocks** — name + status by default; expand for args/result.
- **Phase-based rendering:** queued → running → success/failure.
- **Permission as interruption** — modal or inline; approve/deny/always.
- **Result summarization** — condensed in stream; full on expand.

### 9.2 Streaming Architecture

- **State machine** — thinking → streaming → tool_use → streaming → done.
- **Batch tokens** — cap at ~60fps; coalesce during render.
- **Tool events pass through** — no smoothing/delay on tool_use.
- **Hide system cursor** during streaming (double-cursor artifact).

### 9.3 Status Bar (Persistent)

- Context usage (green → yellow → red)
- Active tool + elapsed
- Todo progress (e.g. 3/7 steps)
- Session cost (if applicable)

### 9.4 Plan-Then-Execute

- Show plan before destructive actions.
- Structured step list with status (pending/running/done/failed).
- Keyboard-togglable overlay (don't replace main view).

### 9.5 Non-Blocking Input

- Allow typing while model thinks (Copilot pattern).
- Queue messages; interrupt support for generation.

### 9.6 Permission UX

- Not just allow/deny — "allow for session" / "always allow" / "deny".
- Clear scope: "Read src/**" vs "Full filesystem".

---

## 10. Quick Reference: Implementation Checklist

| Area | Action |
|------|--------|
| **Colors** | Semantic roles, 4-bit first, NO_COLOR |
| **Symbols** | Unicode + ASCII fallback, never symbol-only |
| **States** | One active spinner, elapsed time visible |
| **Copy** | Terse, active voice, tense discipline |
| **Progress** | Spinner / X of Y / Bar by duration/known |
| **Errors** | One line, actionable, grouped |
| **Density** | Compact default, verbose toggle |
| **Tools** | Collapsible blocks, phase-based, summarization |
| **Accessibility** | Contrast, fallbacks, color-independent |

---

*Sources: clig.dev, NN/g Progressive Disclosure, Evil Martians progress patterns, Better CLI, W3C WCAG2ICT, Temporal error design, homie docs (ai-cli-ux-research, streaming-terminal-patterns, terminal-formatting-catalog, mpp-onboarding, wallet-ux-principles).*
