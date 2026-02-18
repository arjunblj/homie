# Homie v1 runbook

This is the minimum operational guide for running `homie` safely in v1.

## Commands

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run build`

## Running locally

- `bun run packages/homie-ai/src/cli.ts chat`
- `bun run packages/homie-ai/src/cli.ts start`
- `bun run packages/homie-ai/src/cli.ts status`
- `bun run packages/homie-ai/src/cli.ts consolidate`

## Health endpoint

When using `homie start`, the process starts an HTTP health server:

- `GET http://127.0.0.1:9091/health`

It returns:

- `200` when healthy
- `503` when degraded (a dependency check fails)

Health checks include:

- SQLite stores (`sessions.db`, `memory.db`, `feedback.db`, `telemetry.db`)
- background loops (heartbeat, feedback finalization, memory consolidation)

## Graceful shutdown

`homie start` handles `SIGINT`/`SIGTERM`:

- stops heartbeat + health server
- aborts in-flight work (via `AbortSignal`)
- drains turn locks
- closes SQLite connections

## Environment variables

Model provider:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_BASE_URL`

Channels:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OPERATOR_USER_ID` (optional)
- `SIGNAL_API_URL` + `SIGNAL_NUMBER` (signal-cli-rest-api)
- `SIGNAL_DAEMON_URL` or `SIGNAL_HTTP_URL` (signal-cli daemon adapter)
- `SIGNAL_OPERATOR_NUMBER` (optional)

Web tools:

- `BRAVE_API_KEY` (enables `web_search`)

Tools policy (optional):

- `HOMIE_TOOLS_RESTRICTED_ENABLED_FOR_OPERATOR=1`
- `HOMIE_TOOLS_RESTRICTED_ALLOWLIST=tool_a,tool_b`
- `HOMIE_TOOLS_DANGEROUS_ENABLED_FOR_OPERATOR=1`
- `HOMIE_TOOLS_DANGEROUS_ALLOW_ALL=1`
- `HOMIE_TOOLS_DANGEROUS_ALLOWLIST=shell_exec,fs_write`

Logging:

- `HOMIE_LOG_LEVEL` = `debug|info|warn|error|fatal` (default: `warn`)

Engine tuning (optional):

- `HOMIE_ENGINE_LIMITER_CAPACITY`
- `HOMIE_ENGINE_LIMITER_REFILL_PER_SECOND`
- `HOMIE_ENGINE_PER_CHAT_CAPACITY`
- `HOMIE_ENGINE_PER_CHAT_REFILL_PER_SECOND`
- `HOMIE_ENGINE_PER_CHAT_STALE_AFTER_MS`
- `HOMIE_ENGINE_PER_CHAT_SWEEP_INTERVAL`
- `HOMIE_ENGINE_SESSION_FETCH_LIMIT`
- `HOMIE_ENGINE_CONTEXT_MAX_TOKENS_DEFAULT`
- `HOMIE_ENGINE_IDENTITY_PROMPT_MAX_TOKENS`
- `HOMIE_ENGINE_GENERATION_REACTIVE_MAX_STEPS`
- `HOMIE_ENGINE_GENERATION_PROACTIVE_MAX_STEPS`
- `HOMIE_ENGINE_GENERATION_MAX_REGENS`

Typing indicators:

- `HOMIE_SIGNAL_TYPING=1` (enable Signal typing indicator calls; best-effort)

Memory retrieval tuning (optional):

- `HOMIE_MEMORY_RETRIEVAL_RRF_K`
- `HOMIE_MEMORY_RETRIEVAL_FTS_WEIGHT`
- `HOMIE_MEMORY_RETRIEVAL_VEC_WEIGHT`
- `HOMIE_MEMORY_RETRIEVAL_RECENCY_WEIGHT`

## Data files

Under `paths.dataDir`:

- `sessions.db` (short-term session continuity)
- `memory.db` (people/facts/episodes/lessons)
- `feedback.db` (outgoing tracking + outcomes)
- `telemetry.db` (turn stats + token usage; no message content)

## Telegram reactions

Homie learns from implicit feedback (reactions + replies). For Telegram:

- The bot must receive `message_reaction` updates (enabled by `allowed_updates` in the adapter).
- In some group setups, the bot may need admin privileges to receive all updates.

