# homie

Experimental runtime for AI friends. Not assistants. Friends.

Most AI agent frameworks assume you're building a helpful bot. `homie`x assumes you're building a person. It handles the boring parts (memory, timing, message discipline, slop detection) so you can focus on writing a good `SOUL.md`.

```
bunx create-homie my-friend
cd my-friend
# edit identity/SOUL.md, STYLE.md
bunx homie chat
```

## How it works

```
                    ┌─────────────┐
                    │  homie.toml │  config (model, behavior, paths)
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────┴───┐  ┌────┴───┐  ┌────┴───┐
         │ Signal │  │Telegram│  │  CLI   │  channels
         └────┬───┘  └────┬───┘  └────┬───┘
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────┴──────┐
                    │    agent    │  per-chat lock, tool loop,
                    │   runtime   │  slop regen, silence-as-valid
                    └──────┬──────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
      ┌─────┴────┐  ┌─────┴────┐  ┌─────┴────┐
      │ identity │  │ session  │  │  memory  │
      │ SOUL.md  │  │ SQLite   │  │ FTS5     │
      │ STYLE.md │  │ compact  │  │ people   │
      └──────────┘  └──────────┘  │ facts    │
                                  └──────────┘
```

## Project layout

```
homie.toml
identity/
  SOUL.md              who they are
  STYLE.md             how they talk (with example exchanges)
  USER.md              what they know about you
  personality.json     reinforcement keywords
  first-meeting.md     intro template for new people
data/
  session.db           chat history (auto-created)
  memory.db            people, facts, episodes, lessons
```

## What's in the box

- Slop detector (14 categories, ported from a real production agent) with auto-regen
- SQLite memory with full-text search (people, facts, episodes, lessons)
- Adaptive identity prompts with token budgeting
- Sleep mode (quiet hours in the friend's timezone)
- Signal and Telegram adapters, plus a local CLI for testing
- Anthropic, OpenRouter, Ollama, or any OpenAI-compatible model
- Docker image under 100 MB with optional signal-cli sidecar

## CLI

```
homie chat              local CLI chat (you're the operator)
homie start             run all configured channels
homie status            config + memory stats
homie export            dump memory as JSON
homie forget <person>   delete a person and their facts
```

## Config

```toml
[model]
provider = "anthropic"
default = "claude-sonnet-4-5"
fast = "claude-haiku-4-5"

[behavior]
timezone = "America/Los_Angeles"
sleep_mode = true
```

## Deploy

```bash
docker compose --profile signal up -d   # Signal + Telegram
docker compose up -d                     # Telegram only
```

## Future plans

- `create-homie` wizard that interviews you and generates identity files using your LLM
- Voice message transcription and image description
- TTS output (ElevenLabs / OpenAI / Pollinations fallback chain)
- Vector memory tier for users who want it
- Skill system (pluggable `.md` files that extend capabilities)
- Cron scheduler for proactive messages

## Packages

- `packages/homie-ai` - runtime + CLI
- `packages/create-homie` - setup wizard (WIP)

MIT
