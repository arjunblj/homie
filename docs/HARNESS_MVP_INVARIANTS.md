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
- If the memory store `kind` is `http`, local memory-extraction tool-calls are
  skipped entirely—the remote service owns that responsibility.

## Acceptance tests

`packages/homie-ai/src/acceptance/harness.invariants.test.ts` covers:

- Per-chat locking
- Session pre-append before LLM call
- Group newline discipline
- HTTP memory store skips local extraction

