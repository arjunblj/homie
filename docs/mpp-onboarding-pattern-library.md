# MPP Onboarding Pattern Library

Compact UX patterns from fintech/dev CLIs (Stripe, Vercel, Railway, Supabase, gh, npm) for credentials, payments, and secrets. Apply to `homie init` MPP flow.

---

## 1. Auth / Connect Flows

### Device pairing (Stripe-style)
- **Pattern:** CLI requests pairing → server returns `browser_url`, `verification_code`, `poll_url` → user opens URL, confirms code matches → CLI polls until success.
- **Why it works:** No OAuth complexity, no localhost callback, works in headless/SSH.
- **Apply:** If MPP ever adds browser-based wallet connect, use device flow with human-readable verification code (e.g. `apple-secure-whooa-prompt`).

### Browser-first, fallback to manual
- **Stripe:** `stripe login` (browser) vs `stripe login --interactive` (paste API key).
- **Railway:** `railway login` (browser) vs `railway login --browserless` (code + URL).
- **Supabase:** `supabase login` (browser) vs `supabase login --token` or `--no-browser`.
- **Apply:** MPP: default to “open docs” + env var; advanced: `--token` or `--key` for CI/headless.

### One command, one outcome
- **Pattern:** Single entry point (`stripe login`, `gh auth login`) with flags for edge cases.
- **Avoid:** Multiple login commands or provider-specific flags that fragment the flow.

---

## 2. Verification Step Patterns (Doctor / Test)

### Doctor as post-init gate
- **npm doctor:** Checks registry, cache, permissions, git, node version. Clear pass/fail per check.
- **homie doctor:** Already checks config, keys, SQLite, identity. Add MPP-specific: key format, optional connectivity ping.
- **Pattern:** Always recommend `homie doctor` in init completion. Doctor = “did setup work?”

### Verification code confirmation
- **Stripe:** User confirms code on CLI matches code in browser before auth completes.
- **Apply:** For MPP, no live verification code—but you can add a “test request” step: `homie doctor --verify-mpp` that sends a minimal completion to confirm wallet + endpoint work.

### Clear result semantics
- **Pattern:** `OK` | `WARN` | `FAIL` with distinct output (stdout vs stderr for issues).
- **npm:** Per-check feedback; homie doctor already uses issues vs warnings.
- **Apply:** For MPP, add explicit `model: MPP_PRIVATE_KEY valid (0x…abc)` or `model: MPP connectivity OK` when verification succeeds.

### Actionable next steps
- **Pattern:** Each issue ends with a fix hint. e.g. `model: missing MPP_PRIVATE_KEY` → `Set MPP_PRIVATE_KEY in .env (see .env.example)`.
- **Apply:** Doctor MPP issues should point to `.env.example` and docs URL.

---

## 3. Progressive Disclosure (Novice vs Advanced)

### Quick start vs custom
- **homie init:** Already has “Quick start” (recommended provider) vs “Custom” (full provider pick).
- **Pattern:** Default to quick; custom reveals provider list, model overrides, channel setup.
- **Apply:** MPP in quick start = one click if detected; in custom = full model pick + optional docs open.

### Hint-based provider list
- **Pattern:** Each option shows status: `detected` | `not found` | `login required` | `key detected`.
- **homie init:** Already does this (`hint: availability.hasMppPrivateKey ? 'wallet key detected' : 'pay-per-use, needs MPP_PRIVATE_KEY'`).
- **Apply:** Add `wallet key detected` vs `needs MPP_PRIVATE_KEY` consistently; consider `funded` vs `unfunded` if MPP exposes balance.

### Optional deep-dive
- **Pattern:** Don’t ask everything upfront. e.g. identity interview: “Quick” (core only) vs “Deep” (full).
- **Apply:** MPP: quick = set key, done; custom = model pick, base URL override, “open docs?”.

### Environment-specific defaults
- **CI/headless:** `--yes`, `--token`, env vars only. No browser, no prompts.
- **Apply:** `homie init --yes` already skips interactive; ensure MPP works with `MPP_PRIVATE_KEY` only.

---

## 4. Copywriting for Trust (Payments & Keys)

### Emphasize control and safety
- **Pattern:** “Use a dedicated low-balance wallet” (homie already uses this).
- **Stripe:** “Confirm the code matches in your browser” → user verifies before granting.
- **Apply:** Keep “dedicated low-balance wallet”; add “You control the wallet; homie never holds funds.”

### No API key required
- **Pattern:** Lead with benefit: “No API key required — requests paid from a wallet.”
- **Apply:** Keep this; it reduces perceived friction vs Anthropic/OpenAI.

### Transparent about what’s stored
- **Pattern:** “Keys stored in ~/.config/stripe/config.toml” (Stripe). “Token in system keychain” (Supabase).
- **Apply:** “MPP_PRIVATE_KEY stays in .env (gitignored). Never logged or sent except to MPP endpoint.”

### Explicit security choices
- **OpenClaw:** “Non-loopback binds require auth”; “keep auth enabled for local clients.”
- **Apply:** “MPP uses your key only for signing requests to mpp.tempo.xyz. No third parties.”

### Recovery path
- **Pattern:** “If X fails, run Y” or “See Z for help.”
- **Apply:** “If doctor reports MPP issues: check .env, run `homie doctor`, see mpp.tempo.xyz/llms.txt.”

### Avoid fear, add reassurance
- **Avoid:** “Never share your key” (obvious, adds anxiety).
- **Prefer:** “Use a separate wallet for homie. Top up as needed.”
- **Apply:** Replace any alarmist language with practical guidance.

---

## 5. Compact Checklist for homie init MPP

| Area | Current | Apply |
|------|---------|-------|
| **Auth flow** | Env var + optional docs open | Add `--no-browser`-style fallback: “Copy from mpp.tempo.xyz if browser unavailable” |
| **Verification** | Doctor checks key presence | Add `homie doctor --verify-mpp` (optional test request) |
| **Progressive** | Quick vs Custom, hint on MPP | Keep; ensure MPP shows “wallet key detected” when set |
| **Copy** | “Dedicated low-balance wallet” | Add: “You control the wallet; homie never holds funds” |
| **Next steps** | “Set MPP_PRIVATE_KEY” + “Optional: mppx account create” | Add: “Run `homie doctor` to verify” |
| **Trust** | Note with endpoint, docs link | Add one line: “Key stays in .env, used only for MPP requests” |

---

## 6. Reference: CLI Auth Patterns Summary

| CLI | Primary flow | Fallback | Storage |
|-----|--------------|----------|---------|
| Stripe | Device pairing (browser + code) | `--interactive` (paste key) | ~/.config/stripe/config.toml |
| Vercel | OAuth 2.0 device flow | — | Token, 10-day inactivity expiry |
| gh | Browser OAuth | `--with-token`, `--web` | System credential store |
| Railway | Browser | `--browserless` (code+URL) | RAILWAY_TOKEN env |
| Supabase | Browser OAuth | `--token`, `--no-browser` | Native credentials / ~/.supabase |
| npm doctor | — | — | Checks registry, cache, perms, versions |

---

*Sources: Stripe CLI wiki, Ben Tranter (Stripe login), Vercel changelog, gh auth, Supabase/Railway docs, npm doctor, WorkOS CLI auth guide, OAuth device flow (RFC 8628).*
