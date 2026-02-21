# Ink Best Practices for AI Chat TUI Apps

> Research compiled Feb 2026. Ink v6+, @inkjs/ui, streaming patterns, and patterns from Gemini CLI, Codex CLI, and community analysis.

---

## 1. Reference Architecture (Layers/Components)

### Layer Diagram (Top → Bottom)

```
┌─────────────────────────────────────────────────────────────────┐
│  ENTRY LAYER                                                    │
│  index.tsx → render(<App />, { patchConsole, exitOnCtrlC })    │
│  or: withFullScreen(<App />).start() for alternate screen       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  APP LAYER                                                       │
│  App.tsx — mode routing, error boundary, global shortcuts       │
│  - useInput (Ctrl+C, Ctrl+T, ESC)                                │
│  - Error boundary fallback (clean terminal message)             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  CHAT CONTAINER LAYER                                            │
│  ChatView / TerminalChat — state hub, layout orchestration       │
│  - messages[], streamingText, isStreaming, phase                 │
│  - useChat / useBufferedStream / useChunkedStream                │
│  - Mode: idle | thinking | streaming | tool_use | review         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  CONTENT LAYER                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Static (history) — completed messages, committed chunks      ││
│  │ - Rendered once, removed from tree, stays in scrollback      ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Dynamic (active) — streaming text, thinking indicator       ││
│  │ - Only this subtree re-renders on token/state change        ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Overlays — CommandReview, ToolCallCard, slash menu          ││
│  │ - Conditional render, useInput isActive per mode            ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  INPUT LAYER                                                     │
│  InputBar — TextInput (@inkjs/ui or vendored ink-text-input)    │
│  StatusBar — model, shortcuts, streaming status                 │
│  - useInput with isActive when mode === 'input'                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  INK RUNTIME                                                     │
│  React reconciler → Yoga (WASM) layout → renderNodeToOutput      │
│  → full 2D buffer → log-update (eraseLines + write)              │
└─────────────────────────────────────────────────────────────────┘
```

### Component Hierarchy (Recommended)

```
App
├── ErrorBoundary (fallback: clean error message + recovery hint)
└── ChatView
    ├── MessageHistory (Static items)
    │   └── MessageBubble (per completed message)
    ├── StreamingMessage (dynamic — only active message)
    │   ├── ThinkingIndicator (spinner when streaming && !text)
    │   └── StreamingText (buffered text + block cursor ▌)
    ├── ToolCallCard[] (when tool_use phase)
    ├── CommandReview (when review phase — approve/deny)
    ├── StatusBar
    └── InputBar
```

---

## 2. Streaming Without Flicker: Patterns

### Root Cause (INK-ANALYSIS.md)

Ink performs **full-tree traversal and complete screen redraw** on every React state change. `log-update` erases all previous lines (`eraseLines(previousLineCount)`) then writes the full output. At 50–200 tokens/sec, naive `setState` per token causes visible flicker.

### Pattern A: Buffered Batching (Essential)

**DO**: Buffer tokens in `useRef`, flush at 50ms intervals.

```ts
const BATCH_INTERVAL_MS = 50; // ~20 updates/sec, aligns with Ink's 32ms throttle
bufferRef.current += chunk;
// setState only on interval
```

**DON'T**: `setState(prev => prev + chunk)` per token.

### Pattern B: Static for History (Essential)

**DO**: Use `<Static items={completedMessages}>` for finalized content. Static items render once, are removed from the tree, and stay in scrollback. Only the active streaming tail re-renders.

**DON'T**: Keep completed messages in the dynamic tree — they will re-render on every token.

### Pattern C: Message Splitting (Gemini CLI — Best for Long Responses)

**DO**: When streaming text exceeds ~500 chars, split at safe markdown boundaries (`\n\n`, `\n#`, `\n````, sentence end). Commit the head to Static, keep only the tail in state.

```ts
function findLastSafeSplitPoint(text: string): number {
  const patterns = [/\n\n(?=[^\n])/g, /\n(?=#{1,6} )/g, /\n(?=```)/g, /\.\s+(?=[A-Z])/g];
  // ... return index of last match in second half of text
}
```

**DON'T**: Keep a 2000-token response entirely in React state — only the last ~500 chars should be dynamic.

### Pattern D: AI SDK smoothStream (Optional)

**DO**: Consider `smoothStream({ delayInMs: 20, chunking: 'line' })` for terminal — line chunking avoids partial-line ANSI issues.

**DON'T**: Use `delayInMs: 0` or per-token updates unless you've implemented batching yourself.

---

## 3. Static History vs Active Message

### Split Logic

| Content | Component | Re-renders | Storage |
|---------|-----------|------------|---------|
| Completed messages | `<Static items={messages}>` | Never | Scrollback |
| Committed chunks (long stream) | `<Static items={chunks}>` | Never | Scrollback |
| Active streaming text | `<Text>{pendingText}</Text>` | Per flush | `useState` |
| Thinking indicator | `<Spinner />` | Per frame | `useState` |

### Interface

```ts
interface ChatState {
  completed: Array<{ id: string; role: string; content: string }>;
  pendingChunks: Array<{ id: string; content: string }>;  // if using message splitting
  pendingText: string;
  phase: 'idle' | 'thinking' | 'streaming' | 'tool_use' | 'review';
}
```

### Render Structure

```tsx
<Box flexDirection="column">
  <Static items={completed}>
    {msg => <MessageBubble key={msg.id} {...msg} />}
  </Static>
  {phase === 'streaming' && (
    <Box>
      <Text>{pendingText}</Text>
      <Text color="gray">▌</Text>
    </Box>
  )}
  {phase === 'thinking' && <ThinkingIndicator />}
</Box>
```

---

## 4. Input and Command Mode UX

### useInput Patterns

**Global shortcuts** (always active):

```tsx
useInput((input, key) => {
  if (key.ctrl && input === 'c') exit();
  if (key.ctrl && input === 't') toggleModel();
  if (key.escape) cancelStream();
}, { isActive: true });
```

**Mode-specific input** (use `isActive`):

```tsx
useInput(handleSend, { isActive: mode === 'input' });
useInput(handleReview, { isActive: mode === 'review' });
```

### Command Mode Toggles

| Pattern | Use Case | Implementation |
|---------|----------|----------------|
| Slash commands | `/help`, `/model`, `/clear` | Detect `input === '/'` at line start, set `mode = 'slash'` |
| Double-ESC | Confirm cancel (Codex) | Track `lastEscRef`, if second ESC within 1.5s → cancel |
| Tab | Cycle focus | `cycleFocus()` when `key.tab` |
| Ctrl+Arrow | Word jump | Vendored input or custom handler (Option+Arrow often unavailable) |

### Input Component Choices

| Package | Pros | Cons |
|---------|------|------|
| `@inkjs/ui` TextInput | Official, maintained | Newer API |
| `ink-text-input` | Battle-tested (Codex vendors) | May need Ctrl+Arrow patch |
| Custom with `useInput` | Full control | More work |

---

## 5. Error Boundaries and Recovery

### React Error Boundaries

**DO**: Wrap the app in an error boundary with a clean terminal fallback.

```tsx
class ErrorBoundary extends React.Component {
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <Box flexDirection="column">
          <Text color="red">Something went wrong.</Text>
          <Text dimColor>{this.state.error?.message}</Text>
          <Text dimColor>Run with --debug for details.</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
```

**DON'T**: Rely on React's default error overlay — it can corrupt terminal output (Ink issue #234).

### Recovery Patterns

| Scenario | Mitigation |
|---------|------------|
| Raw mode errors | Ensure subprocesses use correct stdio; avoid raw mode conflicts |
| CI hangs | Ink can hang when `CI_*` env vars are set; add timeout or skip interactive mode |
| Stream abort | Clean up interval refs, set phase to idle, show "Cancelled" |
| Terminal resize | Use `useStdout()` dimensions; fullscreen-ink provides `useScreenSize` |

---

## 6. Testing Strategies

### ink-testing-library

```tsx
import { render } from 'ink-testing-library';

const { lastFrame, rerender, stdin } = render(<ChatApp />);
expect(lastFrame()).toContain('Ready');
stdin.write('hello\n');
// Assert on frames after input
```

### Key APIs

| Method | Purpose |
|--------|---------|
| `lastFrame()` | Current stdout output |
| `frames` | All rendered frames (for streaming assertions) |
| `rerender(tree)` | Update props/state |
| `stdin.write(data)` | Simulate keyboard input |
| `unmount()` | Cleanup |

### Testing Checklist

- **Unit**: Hooks (`useBufferedStream`, `useChunkedStream`) with mocked streams
- **Integration**: Full `ChatApp` render, send message, assert `lastFrame()` contains expected text
- **Streaming**: Feed chunks, assert `frames` show incremental updates
- **Input**: `stdin.write('y\n')` for confirmation flows

---

## 7. Performance Pitfalls and Mitigations

### Pitfalls

| Pitfall | Impact | Mitigation |
|---------|--------|------------|
| setState per token | 50–200 re-renders/sec, full redraw each time | Buffer + 50ms flush |
| No Static for history | Entire tree re-renders on every token | Use `<Static>` for completed content |
| Long responses in state | Large tree, slow layout | Message splitting at markdown boundaries |
| Spinner/timer in tree | Constant re-renders | Throttle to 200ms+ or use Static for surrounding content |
| Markdown parse per flush | CPU spike | Debounce parse, or parse only last block |
| Full-screen v6 regression | Extra blank row, scroll | Track Ink #752; consider inline + viewport slice |
| Memory (50MB dev, 32MB prod) | Heavier than native TUIs | Accept trade-off for React ergonomics; bundle for prod |

### Mitigation Summary

1. **Buffer tokens** — never setState per token
2. **Flush at 50ms** — aligns with Ink's 32ms throttle
3. **Static for completed** — removes from render tree
4. **Split long streams** — only tail re-renders
5. **Memoize** — `useMemo` for complex message rendering
6. **Throttle spinners** — 80–200ms frame rate for thinking indicator

---

## 8. Concrete Dos and Don'ts

### Dos

- Buffer tokens in `useRef`, flush at 50ms intervals
- Use `<Static>` for completed messages and committed chunks
- Split long streaming responses at markdown boundaries (Gemini pattern)
- Use `useInput` with `isActive` for mode-specific handlers
- Wrap app in error boundary with clean terminal fallback
- Hide system cursor during streaming (`cli-cursor`)
- Use block cursor `▌` for streaming indicator (standard in AI CLIs)
- Test with `ink-testing-library` (lastFrame, stdin.write)
- Vendor or patch input if you need Ctrl+Arrow (Option often unavailable)
- Debounce or throttle markdown parsing

### Don'ts

- Don't `setState` on every token
- Don't keep completed messages in the dynamic tree
- Don't put frequently-updating timers in the main tree without throttling
- Don't use `console.log` during Ink render (use `patchConsole: false` if you need it, but it can corrupt output)
- Don't assume React's error overlay works cleanly in terminal
- Don't use alternate screen mode if you need native scrollback/selection (trade-off)
- Don't parse full markdown on every flush — batch or parse tail only

---

## 9. Suggested Component Boundaries and Interfaces

### Hooks

```ts
// useBufferedStream: token buffer + 50ms flush
function useBufferedStream(batchMs?: number): {
  text: string;
  isStreaming: boolean;
  stream: (messages: CoreMessage[]) => Promise<void>;
};

// useChunkedStream: message splitting for Static
function useChunkedStream(threshold?: number): {
  staticChunks: Array<{ id: string; content: string }>;
  pendingText: string;
  onToken: (token: string) => void;
};

// useDoubleEscape: Codex-style cancel confirm
function useDoubleEscape(onConfirm: () => void, windowMs?: number): void;
```

### Components

```ts
// MessageBubble: completed message (used inside Static)
interface MessageBubbleProps {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

// StreamingText: active streaming + cursor
interface StreamingTextProps {
  text: string;
  showCursor?: boolean;
}

// CommandReview: approve/deny overlay
interface CommandReviewProps {
  command: string;
  onApprove: () => void;
  onReject: () => void;
}
```

---

## 10. Minimal Implementation Checklist

- [ ] **Entry**: `render(<App />)` or `withFullScreen(<App />).start()`
- [ ] **Error boundary**: Wrap App, clean fallback UI
- [ ] **State**: `messages`, `streamingText`, `phase` (idle | thinking | streaming)
- [ ] **Buffering**: `useRef` buffer + 50ms `setInterval` flush
- [ ] **Static**: `<Static items={completed}>` for history
- [ ] **Splitting** (optional): `findLastSafeSplitPoint` + chunk to Static when >500 chars
- [ ] **Input**: `@inkjs/ui` TextInput or vendored `ink-text-input`
- [ ] **Shortcuts**: `useInput` for Ctrl+C, ESC, Ctrl+T
- [ ] **Thinking**: Spinner when `phase === 'thinking'`
- [ ] **Cursor**: Block `▌` when streaming, hide system cursor
- [ ] **Tests**: `ink-testing-library` render + `lastFrame` + `stdin.write`

---

## References

- [INK-ANALYSIS.md](https://github.com/atxtechbro/test-ink-flickering/blob/main/INK-ANALYSIS.md) — Root cause of Ink flickering
- [ink-ai-sdk-integration-patterns.md](./ink-ai-sdk-integration-patterns.md) — Homie research (Gemini, Codex, AI SDK)
- [streaming-terminal-patterns.md](./streaming-terminal-patterns.md) — Token handling, smoothStream, markdown
- [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) — Message splitting, useFlickerDetector, useBatchedScroll
- [openai/codex](https://github.com/openai/codex) (codex-cli/) — Component hierarchy, double-ESC, vendored input
