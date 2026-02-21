# Ink + AI SDK Integration Patterns Research

> Research compiled Feb 2026. Covers Ink v6.7, Vercel AI SDK, and patterns extracted from Gemini CLI, Codex CLI, and Claude Code.

---

## 1. Architecture Overview: How the Major CLIs Do It

### Google Gemini CLI (95k stars, TypeScript + Ink)
- **Monorepo**: `packages/cli` (UI/rendering) + `packages/core` (API/tools)
- **Ink + React** for all terminal rendering
- **Key innovation**: Message splitting for streaming performance
  - `findLastSafeSplitPoint` — splits large streaming messages at safe markdown boundaries
  - Older message chunks → committed to `<Static />` (rendered once, never re-rendered)
  - Only the latest partial chunk stays as "pending" dynamic content
- **`useBatchedScroll`** — accumulates scroll ops, applies after render
- **`useFlickerDetector`** — detects when rendered content exceeds terminal height, adjusts behavior via `incrementalRendering` flag
- **`usePhraseCycler`** — cycles witty loading phrases during processing
- **~68ms debounce** on terminal output rendering to batch rapid chunks
- **`AppContainer.tsx`** clamps `inputWidth` to min 20 chars

### OpenAI Codex CLI (TypeScript + Ink, migrating to Rust TUI)
- Entry: `src/cli.tsx` → `meow` for arg parsing → `App` → `TerminalChat`
- **Component hierarchy**:
  ```
  App (safety checks, git verification)
  └── TerminalChat (state hub: messages, loading, confirmations)
      ├── MessageHistory (conversation list)
      │   └── TerminalChatResponseItem (per-message renderer)
      ├── TerminalChatCommandReview (approval prompts)
      ├── TerminalChatInput / TerminalChatNewInput
      └── TerminalChatInputThinking (animated spinner)
  ```
- **Vendored `ink-text-input`** in `src/components/vendor/ink-text-input.tsx`
- **Custom key bindings**: Ctrl+Arrow for word jumping (not Option+Arrow)
- **Thinking component**: animated ellipsis (500ms), ball spinner (80ms frames), elapsed seconds counter
- **Double-ESC interrupt**: 1.5s window to confirm cancellation, raw stdin handling

### Claude Code (67k stars, Shell/Python/TypeScript)
- **NOT Ink-based** — uses its own rendering approach (Shell 44.9%, Python 30.5%, TypeScript 18.4%)
- **npm package is deprecated** — now ships native installers
- Vim keybindings, multiline input (Shift+Enter, Option+Enter)
- Model switching and extended thinking mode via keyboard shortcuts
- Ecosystem: `claude-canvas` (TUI toolkit), `terminalcp` (terminal automation)

**Key takeaway**: Gemini CLI is the gold standard for Ink + streaming AI. Codex CLI shows battle-tested component hierarchy. Claude Code isn't Ink.

---

## 2. Streaming AI Output in Ink: Concrete Patterns

### Pattern A: Direct `streamText` → `useState` (Simple)

```tsx
import { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { streamText } from 'ai';

function useStreamingText(model: LanguageModel, prompt: string) {
  const [text, setText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const stream = async () => {
    setIsStreaming(true);
    setText('');
    const { textStream } = streamText({ model, prompt });

    for await (const chunk of textStream) {
      setText(prev => prev + chunk);
    }
    setIsStreaming(false);
  };

  return { text, isStreaming, stream };
}
```

**Problem**: Every token triggers a React re-render → Ink does full tree traversal → terminal flickers at high token rates.

### Pattern B: Buffered Batching (Production)

The pattern used by ChatGPT's web UI and adapted for terminal:

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { streamText, type LanguageModel } from 'ai';

const BATCH_INTERVAL_MS = 50; // 20 updates/sec — human can't tell

function useBufferedStream(model: LanguageModel) {
  const [text, setText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const bufferRef = useRef('');
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const startFlushing = useCallback(() => {
    intervalRef.current = setInterval(() => {
      if (bufferRef.current.length > 0) {
        setText(prev => prev + bufferRef.current);
        bufferRef.current = '';
      }
    }, BATCH_INTERVAL_MS);
  }, []);

  const stopFlushing = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    // Final flush
    if (bufferRef.current.length > 0) {
      setText(prev => prev + bufferRef.current);
      bufferRef.current = '';
    }
  }, []);

  const stream = useCallback(async (messages: CoreMessage[]) => {
    setIsStreaming(true);
    setText('');
    bufferRef.current = '';
    startFlushing();

    const { textStream } = streamText({ model, messages });

    for await (const chunk of textStream) {
      bufferRef.current += chunk;
    }

    stopFlushing();
    setIsStreaming(false);
  }, [model, startFlushing, stopFlushing]);

  return { text, isStreaming, stream };
}
```

**Why this works**: Tokens arrive at 50-200/sec from most providers. Flushing at 20Hz means ~2-10 tokens per render batch. Ink's 32ms render throttle aligns well.

### Pattern C: Gemini-Style Message Splitting (Best for Long Responses)

```tsx
import { useState, useRef, useCallback } from 'react';
import { Static, Box, Text } from 'ink';

interface MessageChunk {
  id: string;
  content: string;
}

function findLastSafeSplitPoint(text: string): number {
  // Split at paragraph boundaries, then block boundaries, then sentence ends
  const patterns = [
    /\n\n(?=[^\n])/g,    // paragraph break
    /\n(?=#{1,6} )/g,    // before heading
    /\n(?=```)/g,         // before code fence
    /\n(?=[-*] )/g,       // before list item
    /\.\s+(?=[A-Z])/g,   // sentence end
  ];

  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      if (lastMatch.index && lastMatch.index > text.length * 0.5) {
        return lastMatch.index + lastMatch[0].length;
      }
    }
  }
  return -1;
}

const SPLIT_THRESHOLD = 500; // chars before attempting split

function useChunkedStream() {
  const [staticChunks, setStaticChunks] = useState<MessageChunk[]>([]);
  const [pendingText, setPendingText] = useState('');
  const fullTextRef = useRef('');
  const chunkIdRef = useRef(0);

  const onToken = useCallback((token: string) => {
    fullTextRef.current += token;
    const current = fullTextRef.current;

    if (current.length > SPLIT_THRESHOLD) {
      const splitIdx = findLastSafeSplitPoint(current);
      if (splitIdx > 0) {
        const committed = current.slice(0, splitIdx);
        const remaining = current.slice(splitIdx);
        fullTextRef.current = remaining;

        setStaticChunks(prev => [
          ...prev,
          { id: `chunk-${chunkIdRef.current++}`, content: committed },
        ]);
        setPendingText(remaining);
        return;
      }
    }
    setPendingText(current);
  }, []);

  return { staticChunks, pendingText, onToken };
}

// Usage in component:
function StreamingMessage() {
  const { staticChunks, pendingText, onToken } = useChunkedStream();

  return (
    <Box flexDirection="column">
      <Static items={staticChunks}>
        {chunk => (
          <Box key={chunk.id}>
            <Text>{chunk.content}</Text>
          </Box>
        )}
      </Static>
      {pendingText && <Text>{pendingText}</Text>}
    </Box>
  );
}
```

**Why this is best**: `<Static>` items render once and are removed from React's tree. Only `pendingText` re-renders on new tokens. For a 2000-token response, only the last ~500 chars are in the live render tree.

---

## 3. Ink's `<Static>` Component — The Key Performance Primitive

`<Static>` is Ink's most important optimization for chat UIs:

```tsx
import { Static, Box, Text } from 'ink';

function ChatHistory({ messages, currentResponse }) {
  // Messages that are complete — rendered once, deleted from tree
  const completedMessages = messages.filter(m => m.status === 'complete');
  // The message currently streaming
  const activeMessage = messages.find(m => m.status === 'streaming');

  return (
    <Box flexDirection="column">
      <Static items={completedMessages}>
        {msg => (
          <Box key={msg.id} flexDirection="column" marginBottom={1}>
            <Text bold color={msg.role === 'user' ? 'blue' : 'green'}>
              {msg.role === 'user' ? '> ' : '● '}
            </Text>
            <Text>{msg.content}</Text>
          </Box>
        )}
      </Static>

      {activeMessage && (
        <Box marginBottom={1}>
          <Text color="green">● {activeMessage.content}</Text>
          <Text color="gray">▌</Text>
        </Box>
      )}
    </Box>
  );
}
```

**How it works internally**:
1. When `<Static>` gets new items, they render immediately (`isStaticDirty` triggers bypass of 32ms throttle)
2. After rendering, static nodes are *deleted from the component tree*
3. Their output remains in the terminal's scrollback buffer
4. Only non-static content participates in future re-renders

**Caveat**: Static content scrolls up and cannot be updated. Use it only for finalized messages.

---

## 4. Fullscreen vs. Inline Rendering

### Inline (Default) — Chat-style
```tsx
import { render } from 'ink';

render(<App />, {
  patchConsole: false,  // preserve console.log output
  exitOnCtrlC: false,   // handle Ctrl+C ourselves
});
```
- Content flows downward like normal terminal output
- Previous output stays in scrollback
- Good for: simple chat, one-shot queries, pipe-friendly output

### Fullscreen — IDE-style
```tsx
import { withFullScreen } from 'fullscreen-ink';

withFullScreen(<App />).start();
// or: withFullScreen(<App />, { exitOnCtrlC: false }).start();
```

```tsx
import { useScreenSize } from 'fullscreen-ink';

function App() {
  const { width, height } = useScreenSize();
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexGrow={1}>{/* chat area */}</Box>
      <Box height={3}>{/* input area */}</Box>
    </Box>
  );
}
```
- Uses alternate screen buffer (like vim/less)
- Terminal restored on exit
- Good for: multi-pane layouts, persistent status bars

**Known issue**: Ink v6 has a regression (#752) adding blank row at bottom in fullscreen mode.

### Hybrid Approach (Gemini CLI style)
Gemini CLI runs inline but manages its own viewport:
- Tracks terminal height via `useStdout()` dimensions
- Manually slices visible messages
- `useFlickerDetector` switches rendering strategy if output exceeds viewport

---

## 5. Keyboard Shortcut Patterns

### Ink's `useInput` Hook

```tsx
import { useInput, useApp } from 'ink';

function App() {
  const { exit } = useApp();

  useInput((input, key) => {
    // Ctrl+C — graceful exit
    if (key.ctrl && input === 'c') {
      cleanup();
      exit();
    }

    // Ctrl+T — toggle model/mode
    if (key.ctrl && input === 't') {
      toggleModel();
    }

    // Escape — cancel current operation
    if (key.escape) {
      cancelStream();
    }

    // Tab — cycle focus
    if (key.tab) {
      cycleFocus();
    }

    // Slash commands
    if (input === '/' && isAtLineStart) {
      enterSlashCommandMode();
    }
  });
}
```

### Codex CLI's Double-ESC Pattern

```tsx
function useDoubleEscape(onConfirm: () => void, windowMs = 1500) {
  const lastEscRef = useRef(0);

  useInput((_input, key) => {
    if (key.escape) {
      const now = Date.now();
      if (now - lastEscRef.current < windowMs) {
        onConfirm();
        lastEscRef.current = 0;
      } else {
        lastEscRef.current = now;
      }
    }
  });
}
```

### Focus Management with `isActive`

```tsx
function ChatInterface() {
  const [mode, setMode] = useState<'input' | 'review'>('input');

  // Only active when in input mode
  useInput((input, key) => {
    if (key.return) sendMessage();
  }, { isActive: mode === 'input' });

  // Only active when reviewing a command
  useInput((input, key) => {
    if (input === 'y') approveCommand();
    if (input === 'n') rejectCommand();
  }, { isActive: mode === 'review' });
}
```

### Key Capabilities (Ink v6)
- Arrow keys, Page Up/Down, Home/End
- Modifier detection: ctrl, shift, meta, super, hyper
- Kitty keyboard protocol: press, repeat, release events, CapsLock/NumLock
- `isActive` option for conditional input capture

---

## 6. Component Libraries for Ink

### `@inkjs/ui` v2.0.0 (Official)
```
npm install @inkjs/ui
```
| Component | Use Case |
|-----------|----------|
| `TextInput` | Single-line input with autocomplete |
| `EmailInput` | Email input with domain completion |
| `PasswordInput` | Masked input (asterisks) |
| `ConfirmInput` | Y/n confirmation |
| `Select` | Scrollable option list |
| `Spinner` | Animated loading indicator |
| `ThemeProvider` | Theme context for all components |

### `ink-markdown` (Markdown Rendering)
```
npm install ink-markdown
```
```tsx
import Markdown from 'ink-markdown';

<Markdown>{`# Hello\n\nThis is **bold** and \`code\``}</Markdown>
```
Based on `marked-terminal`. Props passed through to marked-terminal options.

### Other Useful Packages

| Package | Purpose |
|---------|---------|
| `ink-text-input` | Classic text input (Codex vendors this) |
| `ink-spinner` | Standalone spinner (multiple animation types) |
| `ink-select-input` | Menu/selection lists |
| `ink-scroll-view` | Performance-optimized scrollable container |
| `ink-use-stdout-dimensions` | Terminal size hook |
| `fullscreen-ink` | Alternate screen buffer + fullscreen layout |
| `ink-testing-library` | Render + snapshot testing for Ink components |

---

## 7. Tool Call Visualization

### Spinner → Result Transition Pattern

```tsx
import { useState } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';

type ToolStatus = 'pending' | 'running' | 'complete' | 'error';

interface ToolCallProps {
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  result?: string;
  error?: string;
}

function ToolCallCard({ name, args, status, result, error }: ToolCallProps) {
  const statusIcon = {
    pending: '○',
    running: '',  // spinner replaces this
    complete: '✓',
    error: '✗',
  }[status];

  const statusColor = {
    pending: 'gray',
    running: 'yellow',
    complete: 'green',
    error: 'red',
  }[status];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={statusColor}
      paddingX={1}
      marginBottom={1}
    >
      <Box gap={1}>
        {status === 'running' ? (
          <Spinner label={name} />
        ) : (
          <Text color={statusColor}>{statusIcon} {name}</Text>
        )}
      </Box>

      {status === 'running' && (
        <Text color="gray" dimColor>
          {JSON.stringify(args)}
        </Text>
      )}

      {status === 'complete' && result && (
        <Box marginTop={1}>
          <Text color="gray" wrap="truncate-end">
            {result.slice(0, 200)}
          </Text>
        </Box>
      )}

      {status === 'error' && (
        <Text color="red">{error}</Text>
      )}
    </Box>
  );
}
```

### Codex CLI's Approach: Command Review Flow

```tsx
function CommandReview({ command, onApprove, onReject }) {
  useInput((input, key) => {
    if (input === 'y' || key.return) onApprove();
    if (input === 'n' || key.escape) onReject();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>Run this command?</Text>
      <Box marginTop={1}>
        <Text color="cyan">$ {command}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[y]es / [n]o</Text>
      </Box>
    </Box>
  );
}
```

### Tool Status Tracking (Set-Based, from Codex Architecture)

```tsx
function useToolTracking() {
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [errored, setErrored] = useState<Set<string>>(new Set());

  const startTool = (id: string) => {
    setQueued(prev => { const next = new Set(prev); next.delete(id); return next; });
    setRunning(prev => new Set(prev).add(id));
  };

  const completeTool = (id: string) => {
    setRunning(prev => { const next = new Set(prev); next.delete(id); return next; });
    setCompleted(prev => new Set(prev).add(id));
  };

  const errorTool = (id: string) => {
    setRunning(prev => { const next = new Set(prev); next.delete(id); return next; });
    setErrored(prev => new Set(prev).add(id));
  };

  return { queued, running, completed, errored, startTool, completeTool, errorTool };
}
```

---

## 8. AI SDK `streamText` in Ink (Full Integration)

### Direct Node.js Usage (No HTTP Required)

The AI SDK's `streamText` works directly in Node without HTTP endpoints:

```tsx
import { streamText, type CoreMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

async function* generateStream(messages: CoreMessage[]) {
  const { textStream, toolCalls } = streamText({
    model: anthropic('claude-4-sonnet-20250514'),
    messages,
    tools: { /* tool definitions */ },
  });

  for await (const chunk of textStream) {
    yield { type: 'text' as const, content: chunk };
  }

  // After stream completes, yield tool calls
  for await (const toolCall of toolCalls) {
    yield { type: 'tool-call' as const, ...toolCall };
  }
}
```

### Full Chat Hook for Ink

```tsx
import { useState, useRef, useCallback } from 'react';
import { streamText, type CoreMessage, type LanguageModel } from 'ai';

interface UseChatOptions {
  model: LanguageModel;
  system?: string;
  tools?: Record<string, unknown>;
  onToolCall?: (call: { name: string; args: unknown }) => Promise<string>;
  batchIntervalMs?: number;
}

function useChat({
  model,
  system,
  tools,
  onToolCall,
  batchIntervalMs = 50,
}: UseChatOptions) {
  const [messages, setMessages] = useState<CoreMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const bufferRef = useRef('');
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const send = useCallback(async (userInput: string) => {
    const userMsg: CoreMessage = { role: 'user', content: userInput };
    const currentMessages = [...messages, userMsg];
    setMessages(currentMessages);
    setIsStreaming(true);
    setStreamingText('');
    bufferRef.current = '';

    // Start batch flushing
    intervalRef.current = setInterval(() => {
      if (bufferRef.current) {
        setStreamingText(prev => prev + bufferRef.current);
        bufferRef.current = '';
      }
    }, batchIntervalMs);

    const result = streamText({
      model,
      system,
      messages: currentMessages,
      tools,
    });

    let fullText = '';
    for await (const chunk of result.textStream) {
      bufferRef.current += chunk;
      fullText += chunk;
    }

    // Final flush + cleanup
    clearInterval(intervalRef.current);
    setStreamingText('');
    setIsStreaming(false);

    const assistantMsg: CoreMessage = { role: 'assistant', content: fullText };
    setMessages(prev => [...prev, assistantMsg]);

    // Handle tool calls if any
    const toolCallResults = await result.toolCalls;
    for (const call of toolCallResults) {
      if (onToolCall) {
        const toolResult = await onToolCall({ name: call.toolName, args: call.args });
        // Continue conversation with tool result...
      }
    }
  }, [messages, model, system, tools, onToolCall, batchIntervalMs]);

  return { messages, streamingText, isStreaming, send };
}
```

---

## 9. Chat Interface Layout Pattern

### Inline Chat Layout (Recommended Starting Point)

```tsx
import { Box, Text, useInput, useApp } from 'ink';
import { TextInput } from '@inkjs/ui';
import { Static } from 'ink';

function ChatApp() {
  const { messages, streamingText, isStreaming, send } = useChat({ model });
  const [input, setInput] = useState('');
  const { exit } = useApp();

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      exit();
    }
  });

  const handleSubmit = (value: string) => {
    if (!value.trim() || isStreaming) return;
    send(value);
    setInput('');
  };

  // Separate completed messages from active
  const completed = messages.filter(m => m.role !== 'assistant' || !isStreaming);

  return (
    <Box flexDirection="column">
      {/* Completed messages — rendered once */}
      <Static items={completed.map((m, i) => ({ ...m, key: `msg-${i}` }))}>
        {msg => (
          <Box key={msg.key} marginBottom={1}>
            {msg.role === 'user' ? (
              <Text color="blue">{'> '}{msg.content as string}</Text>
            ) : (
              <Text color="green">{'● '}{msg.content as string}</Text>
            )}
          </Box>
        )}
      </Static>

      {/* Currently streaming response */}
      {isStreaming && streamingText && (
        <Box marginBottom={1}>
          <Text color="green">{'● '}{streamingText}</Text>
          <Text color="gray">▌</Text>
        </Box>
      )}

      {/* Thinking indicator */}
      {isStreaming && !streamingText && (
        <Box marginBottom={1}>
          <Spinner label="Thinking..." />
        </Box>
      )}

      {/* Input */}
      <Box>
        <Text color="blue">{'$ '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type a message..."
        />
      </Box>
    </Box>
  );
}
```

### Fullscreen Chat Layout

```tsx
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { Box, Text } from 'ink';

function FullscreenChat() {
  const { width, height } = useScreenSize();

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header — fixed */}
      <Box borderStyle="single" borderBottom paddingX={1} height={3}>
        <Text bold>homie</Text>
        <Box flexGrow={1} />
        <Text dimColor>claude-4-sonnet · Ctrl+T to switch</Text>
      </Box>

      {/* Messages — grows to fill */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {/* Scrollable message area */}
      </Box>

      {/* Status bar */}
      <Box paddingX={1} height={1}>
        <Text dimColor>
          {isStreaming ? '● Streaming...' : '○ Ready'}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>Ctrl+C quit · ESC cancel</Text>
      </Box>

      {/* Input — fixed */}
      <Box borderStyle="single" borderTop paddingX={1} height={3}>
        <Text color="blue">{'> '}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}

// Entry
withFullScreen(<FullscreenChat />, { exitOnCtrlC: false }).start();
```

---

## 10. Performance Checklist

### Token Throughput
| Technique | Re-renders/sec | Source |
|-----------|---------------|--------|
| Naive `setState` per token | 50-200 | Causes flicker |
| Buffered batching (50ms) | 20 | ChatGPT pattern |
| Ink render throttle | ~31 (32ms) | Built-in |
| `<Static>` for completed | 0 for old msgs | Gemini CLI |
| Message splitting | ~20 for tail only | Gemini CLI |

### Recommended Stack
1. **Buffer tokens in `useRef`** — never setState per-token
2. **Flush at 50ms intervals** — aligns with Ink's 32ms throttle
3. **`<Static>` for completed messages** — removes from render tree
4. **Split long responses at markdown boundaries** — only tail re-renders
5. **Debounce markdown rendering** — don't parse markdown on every flush
6. **Memoize message components** — `useMemo` for complex message rendering

### Ink-Specific Gotchas
- Ink does **full-tree traversal** on every render (no subtree rendering)
- `<Static>` items are rendered then *deleted from the tree* — this is the optimization
- Ink's 32ms throttle prevents some flicker but doesn't help with tree traversal cost
- The `isStaticDirty` flag bypasses the throttle for immediate Static renders
- Terminal resize can cause clearing — use `useStdout` dimensions to react
- `ink-scroll-view` needs manual keyboard binding via `useInput`

---

## 11. Recommended Dependency Set

```json
{
  "dependencies": {
    "ink": "^6.7.0",
    "react": "^18.3.0",
    "@inkjs/ui": "^2.0.0",
    "ink-markdown": "^1.0.4",
    "ink-spinner": "^5.0.0",
    "fullscreen-ink": "^0.1.0",
    "ink-use-stdout-dimensions": "^1.0.5",
    "ai": "^4.0.0",
    "@ai-sdk/anthropic": "latest",
    "@ai-sdk/openai": "latest"
  },
  "devDependencies": {
    "ink-testing-library": "^4.0.0"
  }
}
```

---

## 12. Reference Repos

| Repo | Stars | Ink? | Key Patterns |
|------|-------|------|-------------|
| [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | 95k | Yes | Message splitting, batched scroll, flicker detection |
| [openai/codex](https://github.com/openai/codex) (codex-cli/) | — | Yes | Component hierarchy, vendored ink-text-input, double-ESC |
| [codyde/grok-cli](https://github.com/codyde/grok-cli) | — | Yes | Streaming + tool calling, debug console |
| [ivanleo/building-an-agent](https://github.com/ivanleomk/building-an-agent) | — | Yes | Full tutorial: streaming + tool calls in Ink |
| [daniguardiola/fullscreen-ink](https://github.com/daniguardiola/fullscreen-ink) | 40 | Addon | Alternate screen buffer, responsive sizing |
| [vadimdemedes/ink-ui](https://github.com/vadimdemedes/ink-ui) | — | Core | Official component library |
| [anthropics/claude-code](https://github.com/anthropics/claude-code) | 68k | No | Not Ink — native rendering |

---

## 13. Component Architecture Recommendation for Homie

```
src/cli/
├── index.tsx                    # Entry: render(<App />, opts)
├── App.tsx                      # Top-level: mode routing, error boundary
├── components/
│   ├── ChatView.tsx             # Inline chat layout (Static + streaming)
│   ├── MessageList.tsx          # Maps messages → MessageBubble
│   ├── MessageBubble.tsx        # User/assistant/system message renderer
│   ├── StreamingText.tsx        # Buffered streaming text display
│   ├── ToolCallCard.tsx         # Tool execution visualization
│   ├── CommandReview.tsx        # Approval prompt for dangerous actions
│   ├── ThinkingIndicator.tsx    # Spinner + elapsed time
│   ├── InputBar.tsx             # Text input + slash commands
│   └── StatusBar.tsx            # Model info, shortcuts, streaming status
├── hooks/
│   ├── useChat.ts               # AI SDK streamText integration
│   ├── useBufferedStream.ts     # Token buffering + batch flushing
│   ├── useChunkedStream.ts      # Message splitting for Static optimization
│   ├── useDoubleEscape.ts       # Codex-style interrupt pattern
│   ├── useSlashCommands.ts      # /help, /model, /clear, etc.
│   └── useKeyboardShortcuts.ts  # Global shortcut registry
└── lib/
    ├── markdown.ts              # Throttled markdown rendering
    └── split.ts                 # findLastSafeSplitPoint
```

This architecture combines:
- **Gemini CLI's performance patterns** (message splitting, Static optimization, batched scroll)
- **Codex CLI's component hierarchy** (TerminalChat → MessageHistory → ResponseItem)
- **AI SDK's direct Node.js usage** (streamText without HTTP)
- **Buffered batching** for smooth token rendering
