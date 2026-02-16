# Harness MVP invariants

## What is the harness?

The **harness** is the infrastructure layer that wraps the LLM and manages the
full lifecycle of a conversation turn: intake, context assembly, inference,
tool execution, behavior decisions, persistence, and output. It is the core of
`homie-ai`—everything between a raw incoming message and the outgoing action
that a channel adapter delivers.

The term comes from the broader AI agent ecosystem (see LangChain's runtime /
harness / framework taxonomy). A harness is higher-level than a framework: it
provides opinionated defaults, safety guardrails, and a complete execution path
rather than composable building blocks. In homie's case the harness owns:

- **Turn engine** (`TurnEngine`): the main agent loop. One incoming message
  goes in, one `OutgoingAction` comes out.
- **LLM backend** (`LLMBackend`): provider-agnostic interface to Anthropic,
  OpenRouter, Ollama, or any OpenAI-compatible model.
- **Behavior engine** (`BehaviorEngine`): decides send / react / silence for
  group messages using the fast model.
- **Slop detector**: catches AI-sounding output and triggers regeneration.
- **Session store**: durable chat history with compaction.
- **Memory store**: people, facts, episodes, lessons (SQLite-lite local or HTTP
  remote).

## Invariants

These are the non-negotiable behaviors the harness enforces for production
reliability. Each is backed by an acceptance test in
`packages/homie-ai/src/acceptance/`.

### Turn invariants

- **One-in, one-out**: a single incoming message produces at most one outgoing
  action (`silence`, `send_text`, or `react`).
- **Per-chat serialization**: two concurrent turns for the same `chatId` never
  overlap at the model. Enforced by `PerKeyLock`.
- **Crash-safety**: the user message is appended to the session store *before*
  the first LLM call. If the process dies mid-turn, continuity is preserved.
- **Group discipline**: group-chat outputs are single-message and
  single-paragraph (embedded newlines are collapsed to spaces).

### Memory logging

- `send_text` → episode logged as `USER: … / FRIEND: …`
- `react` → episode logged as `USER: … / FRIEND_REACTION: …`
- `silence` → lesson logged (`silence_decision`); no assistant message appended.

### Remote memory correctness

- If the memory store exposes `getContextPack`, the harness prefers it for
  context injection (server-assembled context > client-side reconstruction).
- Memory extraction is capability-wired at startup: if no local extractor is
  configured, extraction is skipped entirely (e.g. when a remote memory service
  owns that responsibility).

## Memory extraction invariants

- Two-pass extraction: candidates extracted via structured output, then reconciled against existing facts.
- Greetings and small talk produce zero extracted memories.
- Only user messages are extracted; assistant statements are never attributed as user facts.
- Extraction errors never break the main turn — logged as lessons.
- Reconciliation prevents duplicate facts (ADD only when genuinely new).

## Vector search invariants

- When no embedder is available, search degrades gracefully to FTS5-only.
- When sqlite-vec is not loaded, vec0 tables are skipped silently.
- Hybrid search uses Reciprocal Rank Fusion (RRF) to combine FTS5 and vec0 results.

## Context pack invariants

- Memory context never exceeds the configured token budget.
- Relationship context (person + stage) is always present when a person is known.
- Migration fast-path: if store.getContextPack exists, delegates to it.

## Proactive messaging invariants

- Max 1 proactive message per day (excluding explicit reminders), max 3 per week.
- No proactive messages within cooldown window of user's last message.
- No proactive messages during sleep window.
- If last N proactive messages were ignored, pause proactive outreach.
- Never use guilt appeals, FOMO hooks, or engagement re-activation messaging.
- Proactive messaging is disabled by default (opt-in via config).

## Skills invariants

- Filesystem skills default to `restricted` tier unless manifest declares otherwise.
- Malformed skills are skipped without crashing the agent.
- Built-in tools are always loaded unless explicitly disabled.

## Acceptance tests

`packages/homie-ai/src/acceptance/harness.invariants.test.ts` covers:

- Per-chat locking
- Session pre-append before LLM call
- Group newline discipline
- HTTP memory store skips local extraction

