# Homie CLI V1 UX Checklist

This is the V1 ship checklist for setup and chat UX. It is intentionally practical: no experimental UI modes, no dashboards, no heavy observability requirements.

## V1 Principles

- Primary terminal behavior first (copy, select, search, scrollback all work normally).
- Fast perceived response (something visible happens immediately).
- Zero confusing dead states (silence and long-running work are always signaled).
- Trust-forward setup for MPP, Telegram, and Signal.

## Flow Order (User Perspective)

1. `homie init` starts and detects providers.
2. User picks provider (recommended preselected).
3. If MPP is selected: wallet setup -> funding check -> verification.
4. Optional channel onboarding (Telegram, Signal) with immediate validation.
5. Identity interview and generation with visible thinking/progress.
6. `homie doctor` verification.
7. `homie chat` with smooth streaming, tool visibility, and reasoned responses.

## Acceptance Criteria

### Rendering and Performance

- No obvious flicker during long responses.
- Streaming remains smooth under heavy tool output.
- Rendering remains responsive when reasoning deltas are frequent.
- Status bar updates continuously while preserving terminal readability.

### Chat UX

- Compact mode shows active tool + elapsed time.
- Verbose mode shows reasoning traces clearly while streaming.
- Silence state is visible and non-alarming.
- Queue behavior is visible in status bar without transcript spam.
- Attachments can be sent from chat and are visibly represented in the user bubble.

### Setup UX

- Provider detection is explicit and easy to trust.
- MPP wallet flow persists key, offers funding loop, and verifies before real use.
- Telegram token is validated before saving.
- Signal daemon URL is validated before saving.
- Errors are actionable and specific.

### Functional Reliability

- Chat cancellation is safe and does not crash session.
- Attachment file errors are surfaced to user with clear messages.
- `homie doctor --verify-mpp` provides deterministic pass/fail output.
