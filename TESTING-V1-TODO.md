# Testing v1 TODO (QA/staff-level, no fluff)

This is a concrete, short roadmap to make tests catch more *real bugs* with minimal churn.

## Conventions

- Run everything: `bun test --preload ./src/testing/setup.ts`
- Fast-check knobs:
  - `FC_RUNS=200 bun test` (default is intentionally small)
  - `FC_SEED=123 bun test` (repro a failure)
  - `FC_RUNS=300 bun test src/**/**/*.property.test.ts` (deeper sweep)

## Done in this worktree

- Deleted zero-signal smoke tests:
  - `src/smoke.test.ts`
  - `packages/create-openhomie/src/smoke.test.ts`
- Deleted additional zero-signal tests:
  - `src/types/ids.test.ts`
  - `src/cli/ink/usePaymentTracker.test.ts`
  - `src/cli/ink/useSessionUsage.test.ts`
- Replaced create-openhomie smoke with real coverage:
  - Added pure `parseArgs()` in `packages/create-openhomie/src/args.ts`
  - Added `packages/create-openhomie/src/args.test.ts`
- Removed the no-signal “exports function” check from `src/cli/commands/doctor.test.ts`
- De-flaked `TokenBucket` tests by making time deterministic:
  - `src/util/tokenBucket.ts` now accepts injected `now()`/`sleep()`
  - `src/util/tokenBucket.test.ts` no longer asserts wall-clock time or pokes private fields
- Added property testing foundation:
  - Dev dependency: `fast-check`
  - Wrapper: `src/testing/fc.ts`
  - Properties:
    - `src/security/contentSanitizer.property.test.ts`
    - `src/engine/accumulator.property.test.ts`
    - `src/engine/turnEngine.injection.property.test.ts` (kept low-run by default)
- Added tool policy property tests:
  - `src/tools/policy.property.test.ts`
- Added per-chat concurrency stress test:
  - `src/engine/turnEngine.concurrent.test.ts`
- Standardized global mocking (to reduce leak risk):
  - `src/testing/mockFetch.ts` + refactors in `src/tools/read-url.test.ts`, `src/tools/web-search.test.ts`, `src/channels/validate.test.ts`, `src/channels/signal.feedback.test.ts`
  - `src/testing/mockEnv.ts` (used in `src/tools/web-search.test.ts`)
  - `src/testing/mockTime.ts` (used in `src/util/perKeyRateLimiter.test.ts`, `src/util/intervalLoop.test.ts`)
- Quiet test logs by default:
  - `src/testing/setup.ts` sets `OPENHOMIE_LOG_LEVEL=fatal` unless already set
- Started golden tests for stable CLI contracts:
  - `src/testing/golden.ts`
  - `src/cli/usage.test.ts` now writes/compares goldens in `src/cli/__goldens__/`
- Added one metamorphic property:
  - `src/security/contentSanitizer.property.test.ts` ensures injection detection survives benign suffixes

## Inputs needed (to tune v1)

- What does “Braun best-in-class” mean for you here?
  - property/stateful fuzz? mutation testing? LLM judge evals? performance regression tests?
- What’s acceptable runtime for PR gating?
  - e.g. `<30s`, `<2m`, `<5m`
- Should property tests run in CI on every PR, or only nightly?

## Next (highest ROI)

### 1) Replace brittle list assertions with invariants

- `src/tools/registry.test.ts`
  - Keep a “policy contract” test, but avoid coupling to exact full tool lists unless that is explicitly desired.
  - Prefer invariants: safe tools are a subset, restricted/dangerous never appear unless explicitly enabled.

### 2) Stateful fuzz: message sequences (hot-path)

Add `src/engine/turnEngine.sequence.property.test.ts`:

- Generate short sequences of `IncomingMessage` across:
  - DM/group
  - mentioned true/false/undefined
  - operator/non-operator
  - attachments/no attachments
- Invariants (examples):
  - No throws for schema-valid inputs
  - Non-mentioned group input produces `silence:not_mentioned` and does not call backend
  - Duplicate `(chatId,messageId)` produces `silence:duplicate_message`
  - Injection (high/critical) suppresses tools for non-operator turns
  - Silence outcomes never append assistant messages (when a session store is present)

### 3) Golden tests for stable contracts only

Use `src/testing/golden.ts` for:

- prompt skeleton sections that must not churn (system prompt headings, external wrapper tags)
- CLI output formatting that is meant to be stable (doctor JSON shape, help text)

Avoid goldens for:
- timestamps, ids, token-budget-sensitive outputs, or model output

### 4) Fault injection at boundaries (crash-only but meaningful)

Add tests that inject throwing dependencies and assert:
- turn does not leak internal errors into user-visible text
- turn returns a safe `silence` (or a safe error action if that’s the contract)
- telemetry/persistence failures do not crash a turn

Targets:
- `sessionStore.appendMessage` throws
- `memoryStore.trackPerson` throws
- tool execute throws

### 5) LLM eval lane (non-blocking first)

Keep deterministic PR tests strict.
Add a separate lane (manual/nightly) that runs `src/evals/*` cases end-to-end with a judge model and trend tracking.

