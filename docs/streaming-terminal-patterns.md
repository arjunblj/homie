# Streaming AI Output in Terminal Applications

Research compiled Feb 2026. Covers patterns, libraries, and architecture decisions for rendering LLM output in Node.js/Bun terminal apps.

---

## 1. smoothStream (Vercel AI SDK)

The AI SDK ships `smoothStream()` — a `TransformStream` that buffers raw token bursts into human-readable chunks with configurable delay.

```ts
import { smoothStream, streamText } from 'ai';

const result = streamText({
  model,
  prompt,
  experimental_transform: smoothStream({
    delayInMs: 20, // default 10ms
    chunking: 'word', // 'word' | 'line' | RegExp | callback | Intl.Segmenter
  }),
});
```

**How it works:**
- Text tokens get buffered and released on word/line/regex boundaries with a configurable delay between each chunk.
- Non-text chunks (tool calls, step-finish events) pass through immediately — no delay.
- Reasoning/thinking chunks are smoothed separately from text chunks.

**Chunking strategies:**

| Strategy | Use case |
|---|---|
| `'word'` (default) | Latin-script chat, feels like typing |
| `'line'` | Code generation, log-style output |
| `Intl.Segmenter` | CJK languages (ja, zh, ko, th, vi) that lack space delimiters |
| `RegExp` | Custom delimiters (e.g. split on `_` or `,`) |
| Callback `(text) => string \| null` | Full control — return the chunk to emit, or null to keep buffering |

**Terminal-specific considerations:**
- `delayInMs: 10-20` for conversational feel; `delayInMs: 0` (or `null` to disable entirely) for maximum throughput (code/data dumps).
- Line chunking is better for terminal than word chunking when rendering markdown — avoids partial-line ANSI formatting issues.
- The transform is composable: you can chain it with your own TransformStreams for markdown rendering, ANSI coloring, etc.

---

## 2. General Streaming Patterns (Node.js)

### AsyncIterable consumption

The dominant pattern across all LLM SDKs in 2025-2026:

```ts
// Anthropic SDK
const stream = client.messages.stream({ model, messages, max_tokens });
for await (const event of stream) {
  if (event.type === 'content_block_delta') {
    process.stdout.write(event.delta.text);
  }
}

// AI SDK
const result = streamText({ model, prompt });
for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

// OpenAI Agents SDK
const stream = await runner.run(agent, input, { stream: true });
stream.toTextStream().pipe(process.stdout);
```

### Event types to handle in agentic streams

| Event | Description | Action |
|---|---|---|
| `text_delta` | Token of text content | Append to display |
| `thinking_delta` | Extended thinking chunk | Show in thinking indicator |
| `tool_use_start` | Tool invocation begins | Switch to tool visualization |
| `tool_input_delta` | Partial tool arguments | Update tool args display |
| `content_block_stop` | Block complete | Finalize current block |
| `message_stop` | Full response done | Transition to idle state |

### Performance numbers
- Time to first token (TTFT): 200-500ms typical from major providers.
- Token rate: 50-150 tokens/sec typical, bursting to 200+ with batched SSE.
- At 100 tokens/sec with average 4 chars/token, that's ~400 chars/sec — well within terminal rendering capacity.

---

## 3. Token-by-Token Progressive Rendering

### Direct stdout approach (simplest)

```ts
process.stdout.write(chunk); // no newline, immediate display
```

Pros: zero overhead, zero dependencies. Cons: no formatting, no rewind capability.

### log-update approach (in-place rewriting)

```ts
import logUpdate from 'log-update';

let buffer = '';
for await (const chunk of stream) {
  buffer += chunk;
  logUpdate(renderMarkdown(buffer)); // re-renders entire block in-place
}
logUpdate.done(); // persist final output to scrollback
```

`log-update` does partial redraws to minimize flicker. Good for blocks under ~50 lines. For longer content, use block-level incremental rendering (see §5).

### TokenLoom (structured streaming parser)

```ts
import { TokenLoom } from 'tokenloom';

const loom = new TokenLoom({ segmentation: 'word' });

loom.on('text:chunk', ({ content }) => process.stdout.write(content));
loom.on('code:start', ({ lang }) => startCodeBlock(lang));
loom.on('code:chunk', ({ content }) => appendToCodeBlock(content));
loom.on('code:end', () => endCodeBlock());
loom.on('tag:start', ({ name }) => handleCustomTag(name));

for await (const chunk of stream) {
  loom.push(chunk);
}
await loom.flush();
```

Handles arbitrary chunk boundaries (tag split mid-token), emits structured events. Good for custom rendering pipelines.

---

## 4. Typewriter / Animated Text

### DIY with configurable delay

```ts
async function typewrite(
  text: string,
  charDelay = 8,
  stream = process.stdout,
): Promise<void> {
  for (const char of text) {
    stream.write(char);
    if (charDelay > 0) await sleep(charDelay);
  }
}
```

### Using smoothStream as a typewriter

The AI SDK's smoothStream already provides typewriter feel. For terminal:

```ts
const result = streamText({
  model,
  prompt,
  experimental_transform: smoothStream({ delayInMs: 15, chunking: 'word' }),
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

### Libraries

| Library | Approach | Notes |
|---|---|---|
| `dynamicwriter` | Per-char delay with sections | Different speeds per section |
| `node-typewriter` | Simple char-by-char | Minimal, good for small text |
| `timedtext` | Timed TTY text | MIT, lightweight |
| `typewriter-cli` | CLI pipe tool | 1000 char/s default, configurable |

### Key insight
Don't add artificial delay on top of LLM streaming — the natural token arrival rate already produces a good typewriter effect. Only add smoothing (`smoothStream`) when tokens arrive in bursts (which they often do from batched SSE).

---

## 5. Streaming Markdown in Terminal

This is the hardest problem. Markdown formatting (bold, headers, code blocks, tables) requires knowing the full syntactic context, but tokens arrive incrementally.

### Architecture (Will McGugan's 4 optimizations)

Applied in Textual's markdown widget, equally applicable in Node.js:

1. **Only the last block can change.** Markdown is a sequence of top-level blocks (paragraph, heading, code fence, table). When appending tokens, only the final block can be affected. Prior blocks are finalized.

2. **Update widgets, don't replace them.** When the last block's type doesn't change (paragraph stays paragraph), update its content in-place rather than destroying and recreating.

3. **Parse only the last block.** Store the line number where the last block starts. Feed only that slice to the parser. Keeps parse time <1ms regardless of document size.

4. **Buffer ahead of rendering.** When tokens arrive faster than rendering, concatenate them and deliver as one update. Display is never more than a few ms behind data.

### Implementation for Node.js terminal

```ts
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal());

let fullText = '';
let lastBlockStart = 0;
let renderedUpTo = 0;

for await (const chunk of stream) {
  fullText += chunk;

  // Find the start of the last incomplete block
  const blocks = fullText.split(/\n\n/);
  const completeBlocks = blocks.slice(0, -1).join('\n\n');

  if (completeBlocks.length > renderedUpTo) {
    // Render newly completed blocks
    const newContent = completeBlocks.slice(renderedUpTo);
    process.stdout.write(marked.parse(newContent));
    renderedUpTo = completeBlocks.length;
  }

  // Render the in-progress last block with log-update (in-place)
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock) {
    logUpdate(marked.parse(lastBlock));
  }
}

// Finalize
logUpdate.done();
if (renderedUpTo < fullText.length) {
  process.stdout.write(marked.parse(fullText.slice(renderedUpTo)));
}
```

### Handling incomplete markdown syntax

The `streamdown` / `remend` pattern: detect unterminated syntax and temporarily close it for rendering:

| Incomplete input | Temporary completion |
|---|---|
| `**bold text` | `**bold text**` |
| `` `inline code `` | `` `inline code` `` |
| `[link text` | `[link text]()` |
| `~~strike` | `~~strike~~` |
| ` ```python\ncode ` | ` ```python\ncode\n``` ` |

This approach renders correctly at every intermediate state, then seamlessly transitions when the real closing syntax arrives.

### Libraries for terminal markdown

| Library | Downloads/wk | Notes |
|---|---|---|
| `marked` + `marked-terminal` | 4.3M | De facto standard. Syntax highlighting, tables, emoji. Not streaming-aware — call per-block. |
| `marked-terminal-renderer` | newer | Async rendering, built-in `catmd` CLI. TypeScript. |
| `ink-markdown` / `@inkkit/ink-markdown` | 1.9K | React component for Ink. Wraps marked-terminal. |
| `tokenloom` | small | Event-based parser that detects code fences and custom tags mid-stream. |
| `glow` (Go) | CLI tool | Beautiful markdown rendering but not a library. |

---

## 6. Claude Code's Streaming Architecture

Claude Code uses a layered streaming architecture:

```
User Input
    ↓
claude --input-format stream-json \
       --output-format stream-json \
       --include-partial-messages
    ↓
AsyncGenerator yields events:
  - text_delta (char chunks)
  - thinking_delta (reasoning)
  - tool_use_start / tool_input_delta
  - message_stop
    ↓
Ink React components render each event type
```

**Key design decisions:**
- Persistent session: the CLI process stays alive across turns, maintaining context.
- Bidirectional JSON streaming: both input and output use `stream-json` format.
- `--include-partial-messages` enables character-by-character streaming (vs waiting for complete blocks).
- Tool calls and text are multiplexed on the same stream; the UI dispatches to different components based on event type.
- Interruption support: user can send new messages mid-generation, which queues and interrupts.

**Ink component architecture (from Codex's similar pattern):**
- `App` — top-level state machine (idle → thinking → streaming → tool_use → done)
- `MessageHistory` — renders completed messages
- `StreamingResponse` — live text accumulator with cursor indicator
- `TerminalChatCommandReview` — tool approval UI
- `Spinner` — thinking/loading state

---

## 7. Ink Components for Streaming

### Core Ink streaming pattern

```tsx
import React, { useState, useEffect } from 'react';
import { render, Text, Box } from 'ink';
import Spinner from 'ink-spinner';

function StreamingMessage({ stream }: { stream: AsyncIterable<string> }) {
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      for await (const chunk of stream) {
        setText(prev => prev + chunk);
      }
      setDone(true);
    })();
  }, [stream]);

  return (
    <Box flexDirection="column">
      <Text>{text}{!done && '▌'}</Text>
      {!done && (
        <Box>
          <Spinner type="dots" />
          <Text> generating...</Text>
        </Box>
      )}
    </Box>
  );
}
```

### ink-markdown for formatted output

```tsx
import Markdown from 'ink-markdown';

function FormattedStream({ stream }) {
  const [text, setText] = useState('');
  // ... accumulate text from stream ...
  return <Markdown>{text}</Markdown>;
}
```

### Key Ink libraries for streaming UIs

| Package | Purpose |
|---|---|
| `ink` (v6.7) | React for terminal. Flexbox layout via Yoga. |
| `ink-spinner` | Animated spinners (uses cli-spinners) |
| `ink-text-input` | Text input with cursor |
| `ink-markdown` | Markdown rendering |
| `ink-syntax-highlight` | Code syntax highlighting |
| `ink-select-input` | Selection menus |
| `ink-link` | Clickable terminal links |

### Performance note
Ink re-renders the entire terminal UI on state change. For high-frequency streaming (100+ tokens/sec), batch state updates:

```tsx
const bufferRef = useRef('');
const [displayText, setDisplayText] = useState('');

useEffect(() => {
  const flush = setInterval(() => {
    if (bufferRef.current) {
      setDisplayText(prev => prev + bufferRef.current);
      bufferRef.current = '';
    }
  }, 16); // ~60fps
  return () => clearInterval(flush);
}, []);

// In stream consumer:
bufferRef.current += chunk; // don't trigger re-render per token
```

---

## 8. Cursor/Typing Indicators

### Blinking block cursor (most common in AI CLIs)

```ts
const CURSOR = '▌'; // or '█' or '▊'

function renderWithCursor(text: string, showCursor: boolean): string {
  return showCursor ? text + CURSOR : text;
}

// Blink it
let visible = true;
const blink = setInterval(() => {
  visible = !visible;
  render(text, visible);
}, 530); // Standard terminal blink rate
```

### Cursor visibility management

```ts
import cliCursor from 'cli-cursor';

// Hide system cursor during streaming (prevents double-cursor)
cliCursor.hide();
// ... streaming ...
cliCursor.show(); // restore on completion (also auto-restores on process exit)
```

### State indicators

| State | Visual | Example |
|---|---|---|
| Thinking | Spinner | `⠋ Thinking...` |
| Streaming text | Block cursor | `Hello world▌` |
| Streaming code | Block cursor + syntax highlight | `` ```ts\nconst x▌ `` |
| Tool running | Spinner + label | `⠋ Reading file.ts` |
| Waiting for approval | Static prompt | `Allow? [y/n]` |
| Done | No cursor | `Hello world` |

---

## 9. Tool Call Visualization

### Pattern: phase-based rendering

```ts
type Phase =
  | { type: 'thinking' }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; status: 'running' | 'done' }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'done' };

// Render based on current phase
function renderPhase(phase: Phase): void {
  switch (phase.type) {
    case 'thinking':
      spinner.start('Thinking...');
      break;
    case 'text':
      spinner.stop();
      process.stdout.write(phase.content);
      break;
    case 'tool_call':
      spinner.start(`Running ${phase.name}...`);
      break;
    case 'tool_result':
      spinner.succeed(`${phase.name} completed`);
      break;
    case 'done':
      spinner.stop();
      break;
  }
}
```

### Streaming tool arguments

When tool arguments stream in (via `tool_input_delta`), you can progressively display them:

```ts
let toolArgs = '';
for await (const event of stream) {
  if (event.type === 'tool_input_delta') {
    toolArgs += event.delta;
    // Try to parse partial JSON for preview
    try {
      const partial = parsePartialJson(toolArgs);
      updateToolDisplay(partial);
    } catch {
      // Not parseable yet, show raw
    }
  }
}
```

### Visual hierarchy for tool calls

```
┌ 🔧 search_files
│   pattern: "streaming"
│   directory: "src/"
│   ⠋ Searching...
└ ✓ Found 12 results (340ms)

┌ 📄 read_file
│   path: "src/stream.ts"
│   ✓ Read 245 lines
└
```

Use box-drawing characters for structure, emoji/symbols for type, and spinners for in-progress.

---

## 10. Partial JSON Streaming

When structured output streams in, you need to render it progressively.

### Libraries

| Library | Language | Approach |
|---|---|---|
| `partial-json-parser` | Python | Configurable partial type allowances |
| `@streamparser/json-node` | Node.js | Streaming JSON parser for Node |
| `FlexJSON` | Go | Character-by-character streaming |
| `json-part` | Python | Lightweight repair of incomplete JSON |

### Pattern: accumulate and parse optimistically

```ts
let jsonBuffer = '';

for await (const chunk of stream) {
  jsonBuffer += chunk;

  // Try to extract max valid structure
  const result = tryParsePartial(jsonBuffer);
  if (result) {
    renderPartialResult(result);
  }
}

function tryParsePartial(input: string): unknown | null {
  // Close any open structures
  let patched = input;
  const opens = (patched.match(/{/g) || []).length;
  const closes = (patched.match(/}/g) || []).length;
  patched += '}'.repeat(opens - closes);

  // Similar for arrays
  const openBrackets = (patched.match(/\[/g) || []).length;
  const closeBrackets = (patched.match(/]/g) || []).length;
  patched += ']'.repeat(openBrackets - closeBrackets);

  // Close any open string
  if ((patched.match(/"/g) || []).length % 2 !== 0) {
    patched += '"';
  }

  try {
    return JSON.parse(patched);
  } catch {
    return null;
  }
}
```

### AI SDK structured output streaming

```ts
import { streamObject } from 'ai';
import { z } from 'zod';

const result = streamObject({
  model,
  schema: z.object({
    title: z.string(),
    steps: z.array(z.object({ action: z.string(), detail: z.string() })),
  }),
  prompt,
});

for await (const partial of result.partialObjectStream) {
  // `partial` is a typed partial object — fields appear as they complete
  renderPartialObject(partial);
}
```

---

## 11. Streaming Diff Rendering

### Terminal diff tools

| Tool | Language | Approach |
|---|---|---|
| `diffwatch` (deemkeen) | Go | Real-time file watcher with Bubbletea TUI, colored diff |
| `diffwatch` (sarfraznawaz2005) | Node.js | Split-pane TUI with keyboard nav |
| `sd` | Go | Stream diff: compares two streams of strings |
| `Sidecar` | — | Dashboard for AI agent monitoring with syntax-highlighted diffs |

### Pattern: inline diff as tool result

```ts
import { diffLines } from 'diff';

function renderInlineDiff(oldText: string, newText: string): string {
  const changes = diffLines(oldText, newText);
  return changes.map(part => {
    if (part.added) return chalk.green(`+ ${part.value}`);
    if (part.removed) return chalk.red(`- ${part.value}`);
    return chalk.dim(`  ${part.value}`);
  }).join('');
}
```

### Streaming diff as edits arrive

For agentic file edits, show the diff progressively:

```ts
// When a tool produces a file edit, render the diff immediately
function onFileEdit(path: string, oldContent: string, newContent: string) {
  console.log(chalk.bold(`\n📝 ${path}`));
  console.log(renderInlineDiff(oldContent, newContent));
}
```

---

## 12. Thinking Indicators

### Spinner libraries

| Library | Style | Notes |
|---|---|---|
| `ora` | Elegant, many styles | 54M weekly downloads. `.start()/.stop()/.succeed()/.fail()` |
| `cli-spinners` | 70+ spinner definitions | Data only — use with ora or custom renderer |
| `ink-spinner` | Ink component | React-based, for Ink apps |
| `nanospinner` | Lightweight | 1KB, minimal API |

### State machine for thinking → streaming → done

```ts
import ora from 'ora';

const spinner = ora({ text: 'Thinking...', spinner: 'dots' });

async function handleStream(stream: AsyncIterable<StreamEvent>) {
  let state: 'thinking' | 'streaming' | 'tool' | 'done' = 'thinking';
  spinner.start();

  for await (const event of stream) {
    switch (event.type) {
      case 'thinking_delta':
        // Stay in thinking state, optionally update text
        spinner.text = `Thinking... (${event.thinkingLength} chars)`;
        break;

      case 'text_delta':
        if (state === 'thinking' || state === 'tool') {
          spinner.stop();
          state = 'streaming';
        }
        process.stdout.write(event.text);
        break;

      case 'tool_use_start':
        if (state === 'streaming') {
          process.stdout.write('\n');
        }
        state = 'tool';
        spinner.start(`Running ${event.name}...`);
        break;

      case 'tool_result':
        spinner.succeed(`${event.name} done`);
        break;

      case 'message_stop':
        if (state !== 'streaming') spinner.stop();
        state = 'done';
        process.stdout.write('\n');
        break;
    }
  }
}
```

### Elapsed time display

```ts
const startTime = Date.now();
const timer = setInterval(() => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  spinner.suffixText = chalk.dim(`${elapsed}s`);
}, 100);
```

---

## 13. Concurrent Streams

### Libraries for managing multiple outputs

| Library | Approach |
|---|---|
| `@rushstack/stream-collator` | One "active" stream shows live; others buffer and flush when done |
| `multi-stdout` | Parallel write without interleaving |
| `concurrently` | Prefix-based separation of command outputs |

### Pattern: multiplexed rendering with regions

For Ink-based apps, use separate `<Box>` regions:

```tsx
function AgentView({ agents }: { agents: AgentStream[] }) {
  return (
    <Box flexDirection="column">
      {agents.map(agent => (
        <Box key={agent.id} borderStyle="single" flexDirection="column">
          <Text bold>{agent.name}</Text>
          <StreamingText stream={agent.stream} />
        </Box>
      ))}
    </Box>
  );
}
```

### Pattern: stream collation for raw terminal

```ts
import { StreamCollator } from '@rushstack/stream-collator';

const collator = new StreamCollator();
const stream1 = collator.registerTask('agent-1');
const stream2 = collator.registerTask('agent-2');

// Writes to stream1 and stream2 are serialized to stdout
// Active task streams live; inactive tasks buffer
```

---

## 14. Backpressure and Performance

### The problem
LLM tokens can arrive faster than the terminal can render (especially with markdown formatting). Without backpressure, you get:
- Memory bloat from unbounded buffers
- UI lag (rendering falls behind data)
- Dropped frames / visual glitches

### Solution 1: Coalescing buffer (Will McGugan pattern)

```ts
class CoalescingBuffer {
  private pending = '';
  private rendering = false;

  push(chunk: string): void {
    this.pending += chunk;
    if (!this.rendering) {
      this.flush();
    }
  }

  private async flush(): Promise<void> {
    this.rendering = true;
    while (this.pending) {
      const batch = this.pending;
      this.pending = '';
      await this.render(batch); // async render (may take a few ms)
    }
    this.rendering = false;
  }

  private async render(text: string): Promise<void> {
    // Your rendering logic here
    // If tokens arrived during render, they'll be batched in next flush
  }
}
```

### Solution 2: RAF-style batching (for Ink)

```ts
const FRAME_MS = 16; // ~60fps

let buffer = '';
let frameScheduled = false;

function onToken(chunk: string) {
  buffer += chunk;
  if (!frameScheduled) {
    frameScheduled = true;
    setTimeout(() => {
      setState(prev => prev + buffer);
      buffer = '';
      frameScheduled = false;
    }, FRAME_MS);
  }
}
```

### Solution 3: Node.js stream backpressure

```ts
import { Writable } from 'node:stream';

const terminalSink = new Writable({
  highWaterMark: 1024, // 1KB buffer
  write(chunk, encoding, callback) {
    const text = chunk.toString();
    renderToTerminal(text);
    // callback signals "ready for more"
    // If rendering is slow, this naturally applies backpressure
    callback();
  },
});

// Pipe the LLM stream through processing into the terminal sink
llmStream
  .pipeThrough(smoothStream({ delayInMs: 10 }))
  .pipeThrough(markdownTransform())
  .pipeTo(terminalSink);
```

### Performance guidelines

| Concern | Recommendation |
|---|---|
| Re-render frequency | Cap at 60fps (16ms). Batch tokens within frames. |
| Markdown parsing | Parse only the last block, not the full document. |
| ANSI coloring | Cache formatted blocks. Only re-format the active block. |
| String concatenation | Use array of chunks + join at render time, not repeated `+=` on large strings. |
| Memory | Flush completed blocks to scrollback. Only keep the active block in memory for re-rendering. |
| `highWaterMark` | Tune based on rendering speed. Default 16KB is fine for raw text; lower for expensive rendering. |

---

## Summary: Recommended Stack

For a Bun/TypeScript CLI with streaming AI output:

| Layer | Choice | Why |
|---|---|---|
| **UI framework** | **Ink v6** | React model, Flexbox layout, used by Claude Code / Codex / Wrangler |
| **Streaming transform** | **AI SDK `smoothStream`** | Word/line chunking with delay, passes tool calls through |
| **Markdown rendering** | **`marked` + `marked-terminal`** | 4.3M downloads, syntax highlighting, tables |
| **Streaming markdown** | **Block-level incremental** (McGugan pattern) | Parse only last block, update in-place, coalesce buffer |
| **Spinners** | **`ora`** or **`ink-spinner`** | State transitions: thinking → streaming → tool → done |
| **Cursor indicator** | **`▌` block cursor** + `cli-cursor` hide/show | Standard across AI CLIs |
| **Structured output** | **AI SDK `streamObject`** | Typed partial objects via Zod schema |
| **Diff rendering** | **`diff` npm** + chalk coloring | Inline colored diffs for file edits |
| **Backpressure** | **Coalescing buffer** | Batch tokens faster than render speed |
| **Partial JSON** | **`@streamparser/json-node`** | Streaming JSON parser for progressive display |

### Key principles

1. **Never add artificial delay on top of natural token timing** — LLM SSE already has a typewriter feel. Only smooth when tokens arrive in bursts.
2. **Parse incrementally** — only the last block can change. Everything before it is finalized.
3. **Buffer ahead of rendering** — coalesce tokens that arrive during render. User should never see stale data.
4. **Tool calls pass through immediately** — don't smooth or delay tool call events.
5. **State machine drives UI** — thinking → streaming → tool_use → streaming → done. Each state has distinct visual treatment.
6. **Hide system cursor during streaming** — prevents double-cursor artifacts.
7. **Cap render frequency at 60fps** — batch multiple tokens into single render calls.
