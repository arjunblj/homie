# homie

Framework for generating, deploying, and running AI characters.

```bash
bunx create-homie my-friend
cd my-friend
bunx homie chat
```

## How it works

`homie init` generates a character through an interview. The LLM asks about opinions, contradictions, humor, how they act in groups vs direct messages. You review the output and refine before writing to `SOUL.md`, `STYLE.md`, and `USER.md`.

The turn engine takes one inbound message and produces one action: `send`, `react`, or `silence`. Silence is a first-class outcome -- the engine decides whether to reply before drafting anything, based on group velocity, how much the character has talked recently, sleep schedule, and randomness.

Drafted messages pass through a slop detector that catches assistant-sounding output and regenerates with a friend-voice prompt.

Memory is SQLite with hybrid retrieval: full-text search, vector embeddings, and recency decay combined through rank fusion. People have trust tiers that gate what the character shares. Direct message context stays out of groups.

Each character gets a stablecoin wallet via the [Machine Payments Protocol](https://github.com/tempoxyz/tempo). `homie deploy` provisions a server and deploys the character in one command.

```
                 ┌─────────────────────────────────────────────────────────────┐
                 │                         Harness                             │
Signal ──┐       │                                                             │
Telegram ┼─ in ─→│ Context Builder → Turn Engine → LLM Backend ──→ Wallet ──→ $│
CLI ─────┘← out ─│      ↑                ↓              ↑        stablecoins   │
                 │      │           Behavior          Tools        (MPP)       │
                 │      │        slop · timing     safe/restricted    │        │
                 └──────┼────────────────┼────────────────────────────┼────────┘
                        │                │                        Deploy
                   ┌────┴────┐    ┌──────┴──────┐            (DigitalOcean)
                   │ Session │    │   Memory    │
                   │ SQLite  │    │   SQLite    │
                   └─────────┘    │ people      │
                                  │ facts       │
                                  │ episodes    │
                                  │ lessons     │
                                  └─────────────┘
```

## CLI

```
homie init                     create homie.toml + identity via interview
homie chat                     operator view with streaming and tool traces
homie start                    launch channels (Signal, Telegram)
homie deploy [apply|status|resume|ssh|destroy]
                               provision and manage a server via MPP
homie doctor                   validate config, deps, provider connectivity
homie eval                     run eval cases against current config
homie eval-init                test init quality across backends
homie self-improve             finalize feedback, synthesize lessons
homie trust [list|set|clear]   manage trust tier overrides
homie status                   config + runtime stats
homie export                   dump memory as JSON
homie forget <id>              remove a person and their data
homie consolidate              run a memory consolidation pass
```

Flags: `--json` `--verbose` `--quiet` `--config <path>` `--yes` `--no-color` `--help` `--force` `--verify-mpp`

## Providers

| Provider | Kind | Setup |
|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenRouter | `openrouter` (or `openai-compatible`) | `OPENROUTER_API_KEY` (`base_url` optional only for `openai-compatible`) |
| OpenAI | `openai` (or `openai-compatible`) | `OPENAI_API_KEY` (`base_url` optional only for `openai-compatible`) |
| Ollama | `openai-compatible` | `base_url = "http://localhost:11434/v1"` |
| Claude Code | `claude-code` | `claude` on PATH |
| Codex CLI | `codex-cli` | `codex` on PATH |
| MPP | `mpp` | `MPP_PRIVATE_KEY` (`base_url` optional, defaults to `https://mpp.tempo.xyz`) |

## Config

Minimal `homie.toml`:

```toml
[model]
provider = "openai-compatible"
base_url = "https://openrouter.ai/api/v1"
default = "anthropic/claude-sonnet-4-5"
fast = "anthropic/claude-haiku-4-5"

[behavior]
timezone = "America/Los_Angeles"
sleep_mode = true
```

Any OpenRouter model works. You can also point directly at Anthropic, OpenAI, Ollama, or use Claude Code / Codex CLI.

Defaults cover the rest. Full reference:

<details>
<summary>behavior</summary>

```toml
[behavior]
timezone = "America/Los_Angeles"
sleep_mode = true
sleep_start = "23:00"
sleep_end = "07:00"
group_max_chars = 240
dm_max_chars = 420
min_delay_ms = 3000
max_delay_ms = 18000
debounce_ms = 15000
```
</details>

<details>
<summary>memory</summary>

```toml
[memory]
enabled = true
context_budget_tokens = 2000
capsule_enabled = true
capsule_max_tokens = 200
decay_enabled = true
decay_half_life_days = 30
retrieval_rrf_k = 60
retrieval_fts_weight = 0.6
retrieval_vec_weight = 0.4
retrieval_recency_weight = 0.2
feedback_enabled = true
feedback_finalize_after_ms = 7200000
feedback_success_threshold = 0.6
feedback_failure_threshold = -0.3
consolidation_enabled = true
consolidation_interval_ms = 21600000
consolidation_model_role = "default"
```
</details>

<details>
<summary>proactive</summary>

```toml
[proactive]
enabled = false
heartbeat_interval_ms = 1800000
```
</details>

<details>
<summary>tools</summary>

```toml
[tools]
restricted_enabled_for_operator = true
restricted_allowlist = []
dangerous_enabled_for_operator = false
dangerous_allow_all = false
dangerous_allowlist = []
```
</details>

## Memory

Four entity types in SQLite:

| Entity | What it tracks |
|---|---|
| People | Name, relationship score, trust tier, per-person capsule |
| Facts | Structured facts with category, evidence quotes, source |
| Episodes | Conversation summaries tied to a chat and its participants |
| Lessons | Behavioral lessons: success, failure, pattern |

Retrieval combines full-text search, vector search, and recency decay through rank fusion. A consolidation loop updates person capsules and group summaries on a configurable interval.

## Tools

Three sources: builtin (ships with `homie-ai`), identity (`identity/tools/<pack>/index.{js,ts}`), and skill (`skills/<name>/index.{js,ts}`).

Each tool declares a tier: `safe`, `restricted`, or `dangerous`. The harness enforces tiers per-chat. Non-operator chats get `safe` only. Operator chats get `safe` + `restricted`. `dangerous` is opt-in. Tools with a `guidance` field get that text injected into the system prompt.

## Deploy

`homie deploy` provisions a DigitalOcean droplet paid with Machine Payments Protocol stablecoins. State persists to `data/deploy.json` and the flow is resumable:

```
validate → funding_gate → provision → bootstrap → deploy_runtime → verify → done
```

If a step fails, `homie deploy resume` picks up where it left off.

Env vars: `MPP_PRIVATE_KEY` (required), `MPP_MAX_DEPOSIT`, `HOMIE_DEPLOY_REGION`, `HOMIE_DEPLOY_SIZE`, `HOMIE_DEPLOY_IMAGE`, `HOMIE_DEPLOY_REPO`, `HOMIE_DEPLOY_REF`, `HOMIE_DEPLOY_MAX_PER_REQUEST_USD`, `HOMIE_DEPLOY_MAX_PER_DAY_USD`.

## Docker

```bash
docker compose --profile signal up -d   # Signal + Telegram
docker compose up -d                     # Telegram only
```

Non-root user, all capabilities dropped, health check on `:9091/health`, Watchtower for auto-updates.

## Packages

| Package | What |
|---|---|
| [`homie-ai`](packages/homie-ai) | Conversation harness, CLI, turn engine, memory, channels |
| [`create-homie`](packages/create-homie) | Setup wizard (`bunx create-homie`) |
| [`homie-interview-core`](packages/homie-interview-core) | Interview orchestration, identity generation, refinement |

## Development

```bash
bun install
bun run test          # all workspaces
bun run typecheck     # tsc
bun run lint          # biome check
bun run format        # biome check --write
```

## License

MIT
