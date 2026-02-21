# AI CLI/TUI UX Patterns Research

Research compiled Feb 2026. Extracts implementation patterns from Claude Code, Gemini CLI, OpenAI Codex CLI, GitHub Copilot CLI, and Aider that make them feel exceptional.

---

## 1. High-Confidence Patterns (10–15)

### P1: Customizable Status Line with JSON Session Data

**Source:** [Claude Code statusline docs](https://code.claude.com/docs/en/statusline)

**Pattern:** A bottom status bar runs a shell script that receives JSON session data on stdin. The script parses and displays context usage, cost, git status, model name, etc. Updates debounced at 300ms; supports multi-line output, ANSI colors, OSC 8 clickable links.

**Example:** `jq -r '"[\\(.model.display_name)] \\(.context_window.used_percentage // 0)% context"'` for model + context bar.

**Rationale:** Borrows from vim/tmux culture. Gives ambient awareness without context-switching. Configurable via natural language (`/statusline show git branch and cost`).

---

### P2: Slash Commands for Explicit, Repeatable Actions

**Source:** [GitHub Copilot CLI slash commands](https://github.blog/ai-and-ml/github-copilot/a-cheat-sheet-to-slash-commands-in-github-copilot-cli/), [Aider commands](https://aider.chat/docs/usage/commands.html)

**Pattern:** `/`-prefixed commands trigger context-aware actions. Examples: `/clear`, `/add-dir`, `/model`, `/diff`, `/undo`, `/session`. Type `/` to see list. Predictable, keyboard-driven, auditable.

**Rationale:** "Unlike natural language prompts, which can be interpreted in different ways, slash commands always trigger the same response." Improves accessibility and compliance.

---

### P3: Approval Modes with Named Levels

**Source:** [Codex CLI approval modes](https://developers.openai.com/codex/cli/reference), [vladimirsiedykh.com](https://vladimirsiedykh.com/blog/codex-cli-approval-modes-2025)

**Pattern:** Three named modes: `untrusted` (most restrictive), `on-request` (recommended default), `never` (CI/sandbox only). Configurable via CLI flag or `~/.codex/config.toml`. Organizations can enforce via `requirements.toml`.

**Rationale:** Users choose their comfort level. `on-request` balances productivity with safety. `never` only for trusted automation.

---

### P4: Unified Diffs as Primary Edit Format (No Line Numbers)

**Source:** [Aider unified diffs](https://aider.chat/docs/unified-diffs.html)

**Pattern:** Use unified diff format for code edits. GPT omits line numbers; the system interprets hunks as search/replace. Encourage high-level hunks (whole functions) over surgical line edits. Be flexible when applying (outdent, missing `+`, forgotten context).

**Rationale:** 3X reduction in lazy coding vs SEARCH/REPLACE. GPT treats diffs as "textual data for programmatic consumption," not conversational instructions. Familiar format from training data.

---

### P5: Plan-Then-Execute Workflow

**Source:** [GitHub Copilot Plan mode](https://github.blog/ai-and-ml/github-copilot/power-agentic-workflows-in-your-terminal-with-github-copilot-cli/), [Aider architect mode](https://aider.chat/docs/usage/commands.html), [ai-cli-ux-research.md](./ai-cli-ux-research.md)

**Pattern:** Shift+Tab (Copilot) or `/architect` (Aider): ask clarifying questions → build structured plan → user approves → execution. Steps visible as numbered list before any code.

**Rationale:** Builds trust before destructive actions. Reduces surprise edits.

---

### P6: Non-Blocking Input During Thinking

**Source:** [GitHub Copilot CLI](https://github.blog/ai-and-ml/github-copilot/power-agentic-workflows-in-your-terminal-with-github-copilot-cli/), [ai-cli-ux-research.md](./ai-cli-ux-research.md)

**Pattern:** Let users type follow-up messages while the model is "thinking." Loading state is not a blocker.

**Rationale:** Respects user time; they're not waiting passively. 25% average reduction in perceived response time.

---

### P7: Tool Calls as First-Class UI Blocks

**Source:** [ai-cli-ux-research.md](./ai-cli-ux-research.md), [streaming-terminal-patterns.md](./streaming-terminal-patterns.md)

**Pattern:** Each tool invocation = collapsible block. Default: name + spinner + elapsed time. Expand for full args/result. Phase-based rendering: thinking → text → tool_call (running) → tool_result (done).

**Rationale:** Transparency into what the agent is *doing*. Reduces "black box" anxiety.

---

### P8: Progressive Permission Disclosure

**Source:** [Cursor CLI](https://docs.cursor.com), [ai-cli-ux-research.md](./ai-cli-ux-research.md)

**Pattern:** Sandbox by default. On failure: "Skip" / "Run" / "Add to allowlist." Not just allow/deny—"allow for session" / "always allow" / "deny" with clear scope.

**Rationale:** Security doesn't feel like friction. Enabling rather than blocking.

---

### P9: Dynamic Information Density Controls

**Source:** [Claude Code](https://code.claude.com/docs/en/statusline), [ai-cli-ux-research.md](./ai-cli-ux-research.md)

**Pattern:** `Ctrl+O` (verbose toggle), `Ctrl+T` (task list overlay). User controls how much they see in real time during streaming.

**Rationale:** Most CLIs are fixed-density. Power users want compact; novices want detail.

---

### P10: Emacs/Vi Keybindings for Input

**Source:** [Aider keybindings](https://aider.chat/docs/usage/commands.html)

**Pattern:** `Ctrl-R` (reverse search), `Ctrl-X Ctrl-E` (external editor), `Ctrl-Up/Down` (scroll message history). Optional `--vim` for vi mode. Built on prompt-toolkit.

**Rationale:** Terminal users expect familiar bindings. Reduces cognitive load.

---

### P11: Safe Interrupt with Partial Response Preserved

**Source:** [Aider docs](https://aider.chat/docs/usage/commands.html)

**Pattern:** "It's always safe to use Control-C to interrupt aider if it isn't providing a useful response. The partial response remains in the conversation, so you can refer to it when you reply to the LLM with more information or direction."

**Rationale:** User can course-correct without losing context. Avoids "start over" frustration.

---

### P12: Explicit Success Signals and Exit Codes

**Source:** [nibzard.com/agent-experience](https://www.nibzard.com/agent-experience/)

**Pattern:** Avoid "Hang tight…" + "Hooray!"—agents and users need explicit completion. Provide `--json` output, clear exit codes (0=success, 1=invalid args, 2=failed), structured confirmation.

**Rationale:** "If your help text is clear, the agent succeeds in one try. If it's ambiguous, the agent burns API calls retrying."

---

### P13: Repo-Root Rules File for Agent Context

**Source:** [marco.muellner.tech](https://marco.muellner.tech/blog/article_ai_cli_best_practices)

**Pattern:** `CLAUDE.md` (Claude Code), `AGENTS.md` (Opencode), `.aider.conf.yml` (Aider). Include: workflow (plan, tiny diffs, PR), safety (no secrets in logs, no direct writes to main), tech constraints, code style.

**Rationale:** Agent "reads the room." Reduces wrong-context edits.

---

### P14: Special Syntax for Mode Switching

**Source:** [Gemini CLI architecture](https://geminicli.com/docs/architecture/)

**Pattern:** `!` for shell mode, `/command` for slash commands, `@path/to/file` for file references. Single input line, multiple intents.

**Rationale:** Reduces mode-switching friction. Familiar from chat UIs.

---

### P15: Session Persistence and Resumption

**Source:** [Claude Code](https://code.claude.com/docs/en/cli-reference), [ai-cli-ux-research.md](./ai-cli-ux-research.md)

**Pattern:** `claude -c` (continue most recent), `claude -r ""` (resume by ID/name). Session survives terminal crashes.

**Rationale:** Work continuity. Long tasks don't vanish.

---

## 2. Severity-Ranked Anti-Patterns

| Severity | Anti-Pattern | Why It Hurts | Source |
|----------|--------------|--------------|--------|
| **Critical** | Full-auto mode on production | Unbounded changes, no human gate. Use only in CI/sandbox. | [marco.muellner.tech](https://marco.muellner.tech/blog/article_ai_cli_best_practices), [aruniyer.github.io](https://aruniyer.github.io/blog/best-practices-codex-cli.html) |
| **Critical** | Excessive tool access | More tools = more attack surface, higher token usage, unpredictable behavior. | [inventivehq.com](https://inventivehq.com/blog/ai-coding-cli-best-practices), [someclaudeskills.com](https://someclaudeskills.com/docs/skills/skill_coach/references/anti-patterns/) |
| **High** | Overloading context with giant code dumps | Wastes tokens, degrades quality. Use scoped references; let agent fetch. | [aruniyer.github.io](https://aruniyer.github.io/blog/best-practices-codex-cli.html) |
| **High** | Vague success messages ("Hang tight…" "Hooray!") | Agents and users can't tell if operation completed. | [nibzard.com](https://www.nibzard.com/agent-experience/) |
| **High** | Mixing multiple intents in one session | One bug fix + one refactor + style change = messy diffs, regressions. | [aruniyer.github.io](https://aruniyer.github.io/blog/best-practices-codex-cli.html) |
| **High** | Skipping verification after changes | No tests/builds = silent regressions. Always run, paste logs back if fail. | [aruniyer.github.io](https://aruniyer.github.io/blog/best-practices-codex-cli.html) |
| **Medium** | File references that go stale | Point to actual source files, not pasted snippets in config. | [inventivehq.com](https://inventivehq.com/blog/ai-coding-cli-best-practices) |
| **Medium** | "Everything" skills/configurations | One massive agent for entire domain. Split into focused, composable tools. | [someclaudeskills.com](https://someclaudeskills.com/docs/skills/skill_coach/references/anti-patterns/) |
| **Medium** | Blocking input during thinking | User waits passively. Non-blocking input improves perceived speed. | [ai-cli-ux-research.md](./ai-cli-ux-research.md) |
| **Medium** | Delegate code style to LLM | Use linters instead. Focus config on architecture, naming, library preferences. | [inventivehq.com](https://inventivehq.com/blog/ai-coding-cli-best-practices) |
| **Low** | Template theater | Heavy templates; prefer decision logic ("if X, use A; if Y, use B") and anti-patterns. | [someclaudeskills.com](https://someclaudeskills.com/docs/skills/skill_coach/references/anti-patterns/) |
| **Low** | Orphaned reference sections | If you include reference files, tell the agent when to read them. | [someclaudeskills.com](https://someclaudeskills.com/docs/skills/skill_coach/references/anti-patterns/) |

---

## 3. "Steal This Now" Shortlist (Top 5)

1. **Customizable status line with JSON stdin** — Claude Code. Shell script receives session data; displays git, context %, cost. Debounced updates. Zero API cost. Feels native to terminal users.

2. **Unified diffs without line numbers** — Aider. High-level hunks, flexible application. 3X less lazy coding. Simple, familiar format.

3. **Slash commands + `/` discoverability** — Copilot CLI, Aider. Type `/` to see list. Explicit, repeatable, keyboard-driven. Better for trust and compliance.

4. **Approval modes with named levels** — Codex CLI. `untrusted` / `on-request` / `never`. User chooses; org can enforce. Clear mental model.

5. **Plan-then-execute before destructive actions** — Copilot Shift+Tab, Aider `/architect`. Show plan, get approval, then execute. Builds trust, reduces surprise.

---

## 4. Source Links Summary

| Source | URL | Key Content |
|--------|-----|-------------|
| Claude Code statusline | https://code.claude.com/docs/en/statusline | Status line JSON schema, examples, caching |
| Claude Code CLI reference | https://code.claude.com/docs/en/cli-reference | Flags, slash commands, keybindings |
| Codex CLI | https://developers.openai.com/codex/cli | Overview, approval modes, MCP |
| Codex approval modes | https://vladimirsiedykh.com/blog/codex-cli-approval-modes-2025 | untrusted/on-request/never |
| Copilot CLI slash commands | https://github.blog/ai-and-ml/github-copilot/a-cheat-sheet-to-slash-commands-in-github-copilot-cli/ | Full command list, rationale |
| Aider in-chat commands | https://aider.chat/docs/usage/commands.html | 40+ commands, keybindings |
| Aider unified diffs | https://aider.chat/docs/unified-diffs.html | Format design, benchmark results |
| Gemini CLI architecture | https://geminicli.com/docs/architecture/ | Layered architecture, ! / @ syntax |
| AI CLI best practices | https://marco.muellner.tech/blog/article_ai_cli_best_practices | Rules files, scope, MCP |
| Agent-friendly CLI | https://www.nibzard.com/agent-experience/ | --help as API, exit codes, --json |
| homie ai-cli-ux-research | docs/ai-cli-ux-research.md | Rendering, streaming, tool viz |
| homie streaming-terminal-patterns | docs/streaming-terminal-patterns.md | smoothStream, markdown, backpressure |
| homie mpp-onboarding-pattern-library | docs/mpp-onboarding-pattern-library.md | Copy for trust, verification |

---

## 5. Copywriting / Microcopy Patterns

| Pattern | Example | Rationale |
|---------|---------|-----------|
| Lead with benefit | "No API key required — requests paid from a wallet" | Reduces perceived friction |
| Emphasize control | "You control the wallet; homie never holds funds" | Builds trust |
| Transparent storage | "Keys stored in ~/.config/stripe/config.toml" | Reduces uncertainty |
| Actionable next steps | "Set MPP_PRIVATE_KEY in .env (see .env.example)" | Each issue ends with fix |
| Avoid fear language | Prefer "Use a separate wallet for homie" over "Never share your key" | Practical over alarmist |
| Clear exit codes | Document 0/1/2/3 with meanings | Agents parse faster than text |
| Structured output | `--json` for machine consumption | First-try success |
| Sequential instructions | Numbered steps, specific output requirements | Reduces confusion |

---

## 6. Keyboard Interaction Model Summary

| Action | Claude Code | Aider | Copilot |
|--------|-------------|-------|---------|
| Interrupt | Ctrl+C | Ctrl+C (safe, partial kept) | — |
| Submit | Enter | Enter (Meta+Enter in multiline) | Enter |
| History search | Ctrl+R | Ctrl+R | — |
| External editor | Ctrl+G | Ctrl-X Ctrl-E | — |
| Verbose toggle | Ctrl+O | — | — |
| Task list | Ctrl+T | — | — |
| Multiline | `\`+Enter, Option+Enter | `{`/`}` or /multiline-mode | /terminal-setup |
| Exit | Ctrl+D | /exit, /quit | /exit, /quit |

---

*Compiled from Claude Code, Gemini CLI, Codex CLI, Copilot CLI, Aider docs and community reports. Feb 2026.*
