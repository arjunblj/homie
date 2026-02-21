# Thinking Block UI Research

Research on how ChatGPT, Claude.ai, and DeepSeek render "thinking" / reasoning blocks, with focus on patterns adaptable to terminal UIs.

---

## 1. ChatGPT's "Thought for X seconds" Pattern

### Collapsed State
- **Trigger line**: A single clickable row showing a brain icon + "Thought for X seconds" (or "Thinking..." while streaming).
- When the model finishes reasoning, the block **auto-collapses after ~1 second delay**, leaving only the trigger line visible.
- The trigger text transitions from `"Thinking..."` (streaming) to `"Thought for {N} seconds"` (done) to `"Thought for a few seconds"` (if duration is unavailable).

### Expand Animation
- Uses Radix UI `Collapsible` primitive under the hood (same as shadcn/ui).
- Content slides down with a smooth height transition.
- A `ChevronDownIcon` rotates 180 degrees when open (`transition-transform rotate-180`).

### Content Inside
- The reasoning text is rendered as **markdown** (via the Streamdown library in Vercel's implementation).
- Content is styled as **secondary/muted text** -- smaller, dimmer than the final response.
- A **shimmer text effect** plays on the trigger label while streaming: a CSS gradient animation that sweeps left-to-right across the text using `background-clip: text` and `background-size` animation.

### Visual Treatment (from Vercel AI Elements source -- the canonical open-source clone)
```
Trigger:
  - flex items-center gap-2
  - text-muted-foreground (gray/dim text)
  - text-sm (smaller than body text, ~14px)
  - BrainIcon (lucide) + label text + ChevronDownIcon
  - ChevronDown: transition-transform duration-200, rotate-180 when open

Content:
  - text-muted-foreground text-sm (same dim/small treatment)
  - overflow-hidden transition-all (height animation)
  - Streamdown renderer for markdown

Shimmer (while streaming):
  - CSS mask with linear-gradient sweep
  - background-size: 250% 100%
  - animation: shimmer-slide infinite (duration ~2s)
  - Applied as text overlay on the trigger label
```

### Key Insight
ChatGPT uses a **280ms artificial delay** before showing the first response token, creating the *perception* of thoughtful processing. The thinking block is a *secondary* artifact -- the final answer dominates the visual hierarchy.

---

## 2. Claude.ai's Thinking Blocks

### Web UI Behavior
- Extended thinking produces two content block types from the API: a `thinking` block (step-by-step reasoning) followed by a `text` block (final answer).
- On claude.ai, the thinking block is **collapsed by default** after completion.
- During streaming, the thinking content is visible (expanded) so users can watch reasoning unfold.
- Toggle is a simple **click-to-expand/collapse** interaction.

### Claude Code Terminal Rendering
Claude Code (the CLI tool) provides the clearest terminal-native reference:

```
∴ Thought for Xs (ctrl+o to show thinking)
```

- Uses the `∴` (therefore / three dots) symbol as the thinking indicator.
- Collapsed to a **single summary line** by default.
- `ctrl+o` expands to show full thinking content.
- Built with **React + Ink** (terminal React renderer).
- The thinking indicator shows `"thinking... (esc to interrupt)"` during processing.
- Community feedback: users want a config option `"defaultThinkingCollapsed": true/false` for controlling default state.

### Visual Treatment
- Terminal: thinking text rendered in **dim/gray** when expanded, visually subordinate to the main response.
- Web: similar to ChatGPT -- muted text styling, collapsible container.
- No left-border accent in Claude's implementation -- relies on collapse/expand + dim text.

---

## 3. DeepSeek's Reasoning Display

### Default Behavior
- DeepSeek R1 reasoning is **expanded by default** on chat.deepseek.com -- the opposite of ChatGPT/Claude.
- The API returns separate fields: `reasoning_content` (Chain of Thought) and `content` (final answer).
- Reasoning streams in real-time with a "Thinking..." label visible during processing.

### Visual Separation
- In the official DeepSeek web UI:
  - Reasoning content appears in a **visually distinct block** above the final answer.
  - Uses a **lighter/muted text color** for reasoning vs. standard color for the answer.
  - The reasoning section has a **subtle background tint** to differentiate it.
  - The brand color theme is "blue whale" -- accent colors lean toward blue/cyan.

### Open WebUI Implementations
The community has created several rendering approaches for DeepSeek `<think>` blocks:

1. **Collapsible thought filter**: Parses `<think>` tags, renders as foldable widget with spinner/counter.
2. **"Thought for X seconds" panel**: Transforms `<think>` labels into collapsible panels with duration tracking (mirroring ChatGPT's pattern).
3. **Always-expanded mode**: Feature requests exist to keep reasoning expanded by default, showing full chain of thought without requiring clicks.

### Key Insight
DeepSeek's choice to show reasoning expanded by default reflects a different philosophy: **transparency over tidiness**. Users drawn to DeepSeek R1 often *want* to see the reasoning. The collapsing pattern (ChatGPT/Claude) prioritizes clean conversation flow.

---

## 4. The "Left Border Accent" Pattern

### Web UI Pattern
A colored left border (typically 2-4px) is widely used to indicate:
- Quoted/secondary content
- Thinking/reasoning blocks
- Blockquotes and callouts
- Nested or subordinate information

#### Implementations Found

**assistant-ui** (8.5k GitHub stars):
Three variants for reasoning blocks:
```
outline:  "rounded-lg border px-3 py-2"        // full border, subtle
ghost:    ""                                      // no visual container
muted:    "rounded-lg bg-muted/50 px-3 py-2"    // background tint
```

**Vercel AI Elements**:
```
Container: w-full
No explicit left-border -- uses full Collapsible wrapper
Text: text-muted-foreground text-sm
```

**prompt-kit**:
```
Wrapper: custom collapsible with max-height transition
Trigger: ChevronDownIcon with rotation animation
Content: overflow-hidden with ResizeObserver for dynamic height
```

**21st.dev AI Thinking Block** (community component):
- Explicitly features a **left border accent** (`border-l-2` or `border-l-4`).
- Distinguished as a community design pattern specifically for AI thinking.

### Common CSS Pattern
```css
/* The canonical "quoted content" left border */
.thinking-block {
  border-left: 3px solid var(--accent-color);  /* or border-l-2 in Tailwind */
  padding-left: 12px;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
```

This pattern is essentially a **blockquote treatment** repurposed for AI reasoning. It communicates: "this is supplementary content, not the primary answer."

---

## 5. Terminal Adaptation

### Existing Terminal Implementations

#### OpenAI Codex CLI (React + Ink)
Source: `codex-cli/src/components/chat/terminal-chat-input-thinking.tsx`

```
Animation: Shimmer ball "( ● )" cycling through 10 frames at 80ms intervals
Ellipsis: Animated ".", "..", "..." cycling at 500ms
Duration: Elapsed seconds counter displayed alongside
Interrupt: Double-ESC to cancel thinking
```

**Community feedback was negative**: the shimmer animation caused:
- Excessive terminal output (10.72 KB/s before optimization)
- CPU/battery drain in tmux/screen sessions
- Text flickering that made content hard to read

**Lesson**: Terminal animations should be minimal. Prefer static or slowly-cycling indicators over rapid frame-based animation.

#### Claude Code (React + Ink)
```
∴ Thought for Xs (ctrl+o to show thinking)
```
- Single-character indicator (`∴`) + duration + keyboard shortcut hint.
- Collapsed by default, keyboard-toggled.
- No animation during collapsed state -- clean, static.

### Proposed Terminal Patterns

#### Pattern A: Left-Border with Box Drawing Characters
```
│ Thinking...
│
│ The user is asking about X, so I need to consider Y and Z.
│ Let me break this down step by step...
│ First, I'll look at the configuration to understand...
│
```

Implementation with ANSI:
```
\x1b[2m│\x1b[0m  // dim gray vertical bar
\x1b[2m│ content here\x1b[0m  // dim gray bar + dim text
```

Or with color accent:
```
\x1b[36m│\x1b[0m \x1b[2mcontent here\x1b[0m  // cyan bar + dim text
```

#### Pattern B: Collapsed Summary Line (ChatGPT-style)
```
◆ Thought for 3s                          // collapsed (clickable in Ink)
```
Expanded:
```
◆ Thinking...                             // while streaming
│ The user is asking about X...
│ Let me consider Y and Z...
│ First approach: ...
```

#### Pattern C: Separator Lines (DeepSeek-style, always expanded)
```
── thinking ──────────────────────────────
The user is asking about X, so I need to...
Let me break this down:
1. First consideration...
2. Second consideration...
── end thinking ──────────────────────────

Here's the actual answer...
```

#### Pattern D: Hybrid (Recommended)
Combines collapsed summary + left border when expanded:

**While streaming:**
```
◆ Thinking...
│ The user wants to understand how X works with Y.
│ I should explain the architecture first, then...
│ Let me check if there are any edge cases...
```

**After completion (auto-collapse):**
```
◆ Thought for 4s                          [press 't' to expand]
```

**Expanded after completion:**
```
◆ Thought for 4s                          [press 't' to collapse]
│ The user wants to understand how X works with Y.
│ I should explain the architecture first, then
│ dive into the specific implementation details.
│ Let me check if there are any edge cases with
│ the configuration loading...
```

### ANSI Code Reference for Terminal Rendering

```
Dim text:           \x1b[2m ... \x1b[0m
Italic:             \x1b[3m ... \x1b[0m
Dim + Italic:       \x1b[2;3m ... \x1b[0m
Cyan foreground:    \x1b[36m ... \x1b[0m
Gray foreground:    \x1b[90m ... \x1b[0m
Bold:               \x1b[1m ... \x1b[0m

Box-drawing chars:
  │  (U+2502) vertical line
  ─  (U+2500) horizontal line
  ◆  (U+25C6) black diamond (trigger icon)
  ∴  (U+2234) therefore (Claude Code uses this)
  ●  (U+25CF) black circle
```

---

## 6. Open-Source Component Implementations (Source Code)

### Vercel AI Elements (`reasoning.tsx`)
The production-grade reference implementation. Key architecture:

```typescript
// Context provides: isStreaming, isOpen, setIsOpen, duration
const ReasoningContext = createContext<ReasoningContextValue | null>(null);

// Auto-open when streaming starts
useEffect(() => {
  if (isStreaming && !isOpen && !isExplicitlyClosed) {
    setIsOpen(true);
  }
}, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

// Auto-close 1 second after streaming ends (once only)
const AUTO_CLOSE_DELAY = 1000;
useEffect(() => {
  if (hasEverStreamedRef.current && !isStreaming && isOpen && !hasAutoClosed) {
    const timer = setTimeout(() => {
      setIsOpen(false);
      setHasAutoClosed(true);
    }, AUTO_CLOSE_DELAY);
    return () => clearTimeout(timer);
  }
}, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

// Trigger label transitions:
// Streaming:  "Thinking..."  (with shimmer overlay)
// Done:       "Thought for {N} seconds"
// Fallback:   "Thought for a few seconds"
```

Shimmer effect: CSS `mask-image` with `linear-gradient` sweep, `background-size: 250%`, animated with keyframes.

### assistant-ui (`reasoning.tsx`)
Adds variant system and scroll-lock:

```typescript
const reasoningVariants = cva("aui-reasoning-root mb-4 w-full", {
  variants: {
    variant: {
      outline: "rounded-lg border px-3 py-2",
      ghost: "",
      muted: "rounded-lg bg-muted/50 px-3 py-2",
    },
  },
  defaultVariants: { variant: "outline" },
});

// Uses tw-shimmer for the streaming indicator overlay
// ReasoningFade: gradient overlay at bottom of expanded content
//   bg-[linear-gradient(...)] from transparent to background
```

### prompt-kit (`reasoning.tsx`)
Simplest implementation -- pure React, no Radix dependency:

```typescript
// Uses ResizeObserver for dynamic max-height animation
useEffect(() => {
  const observer = new ResizeObserver(() => {
    if (contentRef.current && innerRef.current && isOpen) {
      contentRef.current.style.maxHeight =
        `${innerRef.current.scrollHeight}px`;
    }
  });
  observer.observe(innerRef.current);
  // ...
}, [isOpen]);

// ChevronDownIcon rotates on open
// transition: max-height 300ms ease + opacity 200ms
// isStreaming prop auto-opens/auto-closes
```

---

## 7. Design Principles Summary

| Principle | ChatGPT | Claude | DeepSeek |
|-----------|---------|--------|----------|
| Default state | Collapsed | Collapsed | Expanded |
| Trigger icon | Brain | ∴ (terminal) | None (inline) |
| Duration shown | Yes ("X seconds") | Yes ("Xs") | Via community plugins |
| Streaming behavior | Auto-open, auto-close | Auto-open, auto-close | Always visible |
| Text treatment | Muted, smaller | Dim gray | Lighter color |
| Container | Collapsible, no border | Minimal | Background tint |
| Animation | Shimmer on trigger | Static indicator | None |

### For Terminal Adaptation
1. **Use `│` for left-border accent** -- universally supported, clear visual hierarchy.
2. **Dim text (ANSI `\x1b[2m`)** for thinking content -- subordinate to main response.
3. **Single summary line when collapsed** -- `"◆ Thought for Xs"` or `"∴ Thought for Xs"`.
4. **Auto-collapse after completion** with keyboard toggle to re-expand.
5. **Avoid rapid animations** -- the Codex CLI learned this the hard way. Use static or slowly-cycling indicators.
6. **Show duration** -- users find "Thought for X seconds" informative and satisfying.
7. **Keyboard shortcut hint** -- Claude Code's `(ctrl+o to show thinking)` is excellent UX for discoverability.
