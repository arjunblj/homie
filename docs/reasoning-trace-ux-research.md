# Reasoning Trace UX Research

How products display AI "chain of thought" / reasoning traces, and what research says about optimal transparency.

---

## 1. What to Show vs Hide

### The core tension

NN/g research finds that step-by-step reasoning walkthroughs are often **post-hoc rationalizations**, not faithful representations of how the model arrived at an answer. They may omit influencing factors or adjust their explanation to justify incorrect answers. This creates a dilemma: reasoning traces make products feel approachable and understandable, but risk promoting trust in a flawed tool.

> "We do not have AI that can fully and transparently explain everything it does."
> — Nielsen Norman Group, *Explainable AI in Chat Interfaces*

### What the research recommends

| Level | When to use | Example |
|---|---|---|
| **Status indicator only** | Simple queries, fast responses (<2s) | "Thinking..." with spinner |
| **Summarized reasoning** | Medium complexity, conversational tasks | "Searched 8 sources, compared pricing data" |
| **Full reasoning trace** | Complex/expensive tasks, power users, coding, math | Expandable accordion with step-by-step thought process |

Key findings:

- **University of Washington "Hippo" study**: Presenting reasoning as a hierarchy of topics (not raw text) improved error detection from 73.5% to 85.6% and reduced validation time from 64.7s to 57.9s per question.
- **Vis-CoT study**: Converting linear chain-of-thought into interactive reasoning graphs improved accuracy by up to 24 percentage points while increasing perceived usability and trust.
- **NN/g warning**: Users rarely verify citations or reasoning. The mere *presence* of reasoning creates false confidence. Confident presentations discourage fact-checking.
- **Conversational XAI study (2025)**: Conversational explanations improve understanding vs static dashboards, but create an "illusion of explanatory depth" that paradoxically increases over-reliance.

### Practical guidance

- Default to **collapsed/summarized**. Raw reasoning overwhelms most users and creates false confidence.
- Let power users **opt into full traces** via expand/toggle.
- Never present reasoning as certain truth. Use language like "Considered..." not "I determined that..."
- **Separate plan, execution, and evidence** (ShapeofAI pattern). Users should never wonder whether a citation came from a proposed step or a completed one.

---

## 2. Progressive Disclosure Patterns

### How major products handle show/hide

#### ChatGPT (GPT-5 / o-series)

- **Default**: Collapsed. Shows "Thought for X seconds" as a clickable summary line.
- **Expanded**: Reveals flowing internal monologue text.
- **Duration controls**: Users choose Light / Standard / Extended / Heavy presets for thinking depth. Preferences persist across prompts.
- **During streaming**: Pulsing indicator replaces the usual typing effect. Latency ranges from 1-4s (simple) to 10s+ (analytical).
- **Philosophy**: Thinking is treated as a background process. Users see the *result* of thinking, not the process, unless they actively expand.

#### Claude.ai / Claude Code

- **Web (claude.ai)**: Collapsed by default. Shows "Thinking..." indicator during streaming, then collapses to "Thought for Xs" summary. Click to expand full thinking block.
- **Terminal (claude-code)**: Shows `∴ Thought for 3s` summary banner. Press `ctrl+o` to show thinking content. Displays `thinking… (esc to interrupt)` during processing.
- **API**: Returns separate `thinking` and `text` content blocks. Developers control display. Offers `clear_thinking` strategies to manage context in long conversations.
- **Key detail**: Thinking blocks are visually distinct from response text — lighter/muted treatment in web UI.

#### DeepSeek

- **Web UI**: Shows thinking process expanded by default during streaming (differentiator from ChatGPT/Claude). Users see step-by-step reasoning unfold in real-time inside a visually distinct container.
- **API**: Separate `reasoning_content` and `content` fields. Developer controls display.
- **Philosophy**: Transparency-first. Shows the work rather than hiding it.
- **Constraint**: `reasoning_content` must never be fed back into subsequent requests (causes 400 error).

#### Perplexity

- **Unique approach**: Doesn't show "thinking" per se — shows **search progress**. Specific status messages like "Considering 8 sources" or "Researched and summarized."
- **Pro Search**: Creates visible step-by-step plan for complex queries. Executes searches sequentially with progress shown as tabs above the results pane.
- **Philosophy**: Operational transparency of *actions* (searching, reading, comparing) rather than *thoughts*.

#### v0 (Vercel)

- Exposes reasoning logic inline until ready to start building, then remaining steps move to a left drawer while the app builds in the main canvas.

#### Lovable

- Users follow along with actions and reasoning as it creates their project, shown inline.

### The three-layer model (from progressive disclosure research)

1. **Layer 1 — Index/Summary**: Lightweight status. "Thinking..." / "Searched 5 sources" / "Analyzing code..."
2. **Layer 2 — Details**: Expandable reasoning steps, tool calls, intermediate results.
3. **Layer 3 — Deep Dive**: Full raw reasoning trace, token-level detail, timing data.

Guidelines from research:
- Limit to 2-3 disclosure layers maximum
- Use clear triggers (expand buttons, keyboard shortcuts, not hidden gestures)
- Remember user preferences for expansion state
- Test with both novice and advanced users
- Never hide critical information behind multiple clicks

---

## 3. Visual Treatment of "Thinking" Content

### Web interfaces — common patterns

| Treatment | Used by | Details |
|---|---|---|
| **Collapsed accordion** | ChatGPT, Claude.ai, assistant-ui | Default collapsed. "Thinking" toggle button. Chevron icon indicates state. |
| **Muted/dimmed text** | Claude.ai, assistant-ui, Open WebUI | `text-muted-foreground text-sm italic` — smaller font, gray/muted color, italic. |
| **Bordered container** | DeepSeek, ChatGPT | Rounded border box (`rounded-lg border`) separates thinking from response. |
| **Left border accent** | assistant-ui | `border-l-2 border-muted pl-4` — vertical line on left edge, indented content. |
| **Shimmer animation** | assistant-ui Reasoning component | Animated shimmer effect while thinking is actively streaming. |
| **Duration badge** | ChatGPT, Claude.ai | Shows "Thought for Xs" after completion. Doubles as expand trigger. |
| **Background differentiation** | DeepSeek | Slightly different background color for reasoning container. |

### The assistant-ui reference implementation (React)

```css
/* Reasoning text */
.whitespace-pre-wrap .px-4 .py-2 .text-muted-foreground .text-sm .italic

/* Container */
.my-2 .rounded-lg .border

/* Accordion trigger */
.flex .w-full .cursor-pointer .items-center .gap-2 .px-4 .py-2 .font-medium .text-sm .hover:bg-muted/50

/* Expanded content wrapper */
.border-l-2 .border-muted .pl-4
```

Key visual hierarchy principle: **Reasoning content should be visually subordinate to the final response.** It exists as supporting material, not the primary output. Achieve this through:
- Smaller font size
- Reduced contrast (muted/gray color)
- Italic or lighter weight
- Indentation or left-border treatment
- Collapsed by default

### Terminal interfaces — common patterns

| Treatment | Used by | Details |
|---|---|---|
| **Summary banner** | Claude Code | `∴ Thought for 3s (ctrl+o to show thinking)` |
| **Spinner/braille animation** | Claude Code, Gemini CLI | Animated characters (`⠋ ⠙ ⠹`) in terminal title/status line |
| **Dimmed ANSI text** | Various CLI tools | `\x1b[2m` (dim) or `\x1b[90m` (bright black/gray) for thinking text |
| **Status symbols** | GCLI, Conduit | `●` (active), `░` (processing), `✓` (complete) |
| **Indented/prefixed lines** | Common pattern | Prefix reasoning lines with `  │ ` or `  > ` to visually nest them |
| **Bracketed sections** | Common pattern | `── Thinking ──` / `── Done (3.2s) ──` horizontal rules |

---

## 4. Streaming Reasoning UX

### The "Elevator Mirror Effect"

From the nohe.dev operational transparency research: Users waiting for AI perceive time passing slower. Animated indicators and visible activity reduce *perceived* wait time, even when actual processing time is unchanged. The analogy: elevator mirrors exist to make people feel like the wait is shorter.

> "When a screen freezes, users assume it's broken. When a screen shows activity, users assume it's working. We need to turn the LLM black box into a glass box."

### Transit station research

TfL (London transit) research found that having a timetable at bus stops reduces anxiety about waiting — even when the bus is late. The confirmation of delay reduces the cognitive load of uncertainty. Same principle applies to AI streaming: showing that the system is working through a problem gives users peace of mind.

### During-streaming patterns

**What works:**

1. **Animated status line with current step**: "Thinking: Analyzing code structure..." that updates as the model progresses through reasoning. Extract step titles from the thought stream (e.g., bolded headers).
2. **Elapsed time counter**: Show "Thinking... (3s)" that ticks up. Sets expectations and signals liveness.
3. **Collapsible live stream**: Show reasoning tokens streaming in real-time inside a collapsible container. Users who want to watch can expand; others see just the status line.
4. **Step state indicators**: Each step gets a state: queued → running → completed. Gives a sense of progress through a multi-step process.
5. **Interrupt affordance**: Always show how to stop/interrupt. "Thinking... (esc to interrupt)" or a stop button. Users need an escape hatch.

**What doesn't work (anti-patterns):**

- Blank screen with no indicator (users assume crash after ~3s)
- Generic spinner with no context ("Loading..." tells users nothing)
- Wall of streaming text that scrolls too fast to read
- Content that auto-scrolls aggressively, preventing users from reading earlier parts
- Flickering/resizing status indicators (Claude Code braille spinner issue)
- No clear completion signal (ambiguous end states)

### Streaming architecture

The recommended pattern separates thought streaming from response streaming:

```
[Stream starts]
  → Thought tokens arrive → Show in collapsible "Thinking" container
  → Thought stream ends → Collapse thinking, show duration
  → Response tokens arrive → Show in main response area
[Stream ends]
```

For terminal/CLI specifically:
- Use a single status line that updates in-place (carriage return `\r`)
- Show elapsed time
- On completion, collapse to one-line summary
- Optionally support a verbose flag (`--show-thinking`) for full trace

---

## 5. Reasoning Trace Formatting

### Research on format effectiveness

The University of Washington interactive reasoning study compared three formats:

| Format | Error detection rate | Validation time |
|---|---|---|
| **Linear text (iCoT)** | 73.5% | 64.7s |
| **Code/program (iPoT)** | 78.2% | 61.3s |
| **Graph visualization (iGraph)** | **85.6%** | **57.9s** |

Structured/visual formats significantly outperform raw text for comprehension and error detection.

### Accordion-Thinking research (2025)

The "Accordion-Thinking" paper proposes that models self-regulate their reasoning display by generating **step summaries** — compressed versions of each reasoning step. This reduces token count while maintaining readability. The model itself decides what to compress and what to keep verbose.

### Practical formatting options

**For web interfaces:**

| Format | Best for | Example |
|---|---|---|
| **Step list with headers** | Multi-step reasoning | Bold step title, muted detail text beneath |
| **Flowing text (italic/muted)** | Stream-of-consciousness thinking | ChatGPT/Claude style raw thought stream |
| **Key-value pairs** | Tool calls, parameter decisions | `Model: gpt-4o` / `Temperature: 0.7` |
| **Abbreviated summary** | Most users, collapsed state | "Analyzed 3 files, found 2 issues, generated fix" |
| **Bullet points** | Post-hoc reasoning summary | Concise list of considerations |

**For terminal interfaces:**

| Format | Best for | Example |
|---|---|---|
| **Single status line** | During streaming | `⠹ Thinking: Analyzing dependencies... (4s)` |
| **Indented dim text** | Expanded reasoning | `  │ Checking if package.json exists...` |
| **Bracketed summary** | Completed thinking | `── Thought for 3.2s ──` |
| **Bullet list** | Post-completion detail | `  • Searched 5 files  • Found 2 matches` |
| **Progress steps** | Multi-step operations | `[1/3] Analyzing... [2/3] Planning... [3/3] Done` |

### Recommended defaults

1. **During streaming**: Single animated status line with current step name and elapsed time.
2. **After completion**: Collapsed one-line summary with duration. Expandable to full trace.
3. **Expanded format**: Step list with bold headers and muted detail text. Not raw flowing text.
4. **Terminal**: Dim text with left-border prefix (`│`). Collapsed to one-line summary by default.

---

## 6. Product Pattern Summary

| Product | Default state | Thinking visual | Streaming indicator | Expand gesture | Format |
|---|---|---|---|---|---|
| **ChatGPT** | Collapsed | Bordered box, muted | Pulsing dot + "Thought for Xs" | Click summary | Flowing text |
| **Claude.ai** | Collapsed | Muted/lighter container | "Thinking..." label | Click summary | Flowing text |
| **Claude Code** | Hidden | Dim terminal text | `thinking… (esc)` banner | `ctrl+o` | Raw text |
| **DeepSeek** | Expanded | Different background container | Live streaming in box | Already open | Flowing text |
| **Perplexity** | Visible | Progress tabs | "Considering N sources" | N/A (always shown) | Step status list |
| **v0** | Inline → drawer | Left drawer panel | Inline reasoning text | Automatic transition | Step list |
| **Lovable** | Inline | Inline with response | Live action narration | N/A (always shown) | Action log |
| **assistant-ui** | Collapsed | `text-sm italic text-muted` | Shimmer animation | Click accordion | Configurable |

---

## 7. Design Recommendations for Homie

Based on this research, recommendations ordered by confidence:

### High confidence

1. **Collapse by default, expand on demand.** The ChatGPT/Claude pattern is the emerging standard. Most users don't want raw reasoning. Power users do.
2. **Always show liveness during thinking.** A blank screen is the worst UX. At minimum: animated indicator + elapsed time + interrupt affordance.
3. **Visually subordinate reasoning to response.** Smaller, dimmer, italic, indented — reasoning is supporting material, not the main event.
4. **Show action summaries, not thought summaries.** "Searched 5 files, found 2 issues" (Perplexity-style) is more useful than "I'm thinking about whether the code has issues" (anthropomorphic reasoning).
5. **Provide an interrupt/escape mechanism.** Users must be able to stop thinking if it's taking too long.

### Medium confidence

6. **Use step-based formatting over flowing text.** Research shows structured formats improve comprehension. Bold step headers with muted detail text underneath.
7. **Remember user preferences.** If a user always expands thinking, default to expanded for them.
8. **Show duration after completion.** "Thought for 3.2s" sets expectations for future queries and signals the thinking phase is over.

### For terminal/CLI specifically

9. **Single status line during streaming** that updates in-place. Include: spinner + current step + elapsed time.
10. **Collapse to one-line summary on completion.** `✓ Thought for 3.2s` or `── Analyzed 3 files (3.2s) ──`
11. **Support `--show-thinking` / `--verbose` flag** for users who want full traces.
12. **Use dim ANSI color + left-border prefix** for expanded reasoning text to visually separate it from response content.

---

## Sources

- Nielsen Norman Group — [Explainable AI in Chat Interfaces](https://www.nngroup.com/articles/explainable-ai/)
- ShapeofAI — [Stream of Thought Pattern](https://www.shapeof.ai/patterns/stream-of-thought)
- assistant-ui — [Chain of Thought Guide](https://www.assistant-ui.com/docs/guides/chain-of-thought)
- nohe.dev — [Don't Make Them Wait: Improving AI UX with Streaming Thoughts](https://nohe.dev/posts/2026/02/operational-transparency)
- UW Interactive Reasoning — [Visualizing and Controlling Chain-of-Thought Reasoning in LLMs](https://arxiv.org/html/2506.23678v1)
- ReTrace — [Interactive Visualizations for Reasoning Traces](https://arxiv.org/html/2511.11187v1)
- Vis-CoT — [Human-in-the-Loop Framework for Interactive Visualization](https://arxiv.org/abs/2509.01412)
- Agentic Design — [Progressive Disclosure Patterns](https://agentic-design.ai/patterns/ui-ux-patterns/progressive-disclosure-patterns)
- AI UX Design Guide — [Progressive Disclosure](https://www.aiuxdesign.guide/patterns/progressive-disclosure)
- UX Planet — [Progressive Disclosure in AI-Powered Product Design (2026)](https://uxplanet.org/progressive-disclosure-in-ai-powered-product-design-978da0aaeb08)
- Accordion-Thinking — [Self-Regulated Step Summaries for Efficient LLM Reasoning](https://arxiv.org/html/2602.03249v1)
- Anthropic — [Building with Extended Thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- DeepSeek — [Reasoning Model API Docs](https://api-docs.deepseek.com/guides/reasoning_model)
- Honra — [Why AI Agents Need Progressive Disclosure](https://www.honra.io/articles/progressive-disclosure-for-ai-agents)
