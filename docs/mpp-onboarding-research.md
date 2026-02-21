# MPP/Tempo Wallet Payment Onboarding Research

Research for LLM/model usage via MPP (Machine Payments Protocol) and Tempo. Used to design world-class MPP onboarding in `homie init`.

---

## 1. Official Docs & Resources

| Resource | URL | Purpose |
|----------|-----|---------|
| MPP Proxy index | https://mpp.tempo.xyz/llms.txt | LLM-friendly index of services |
| MPP OpenRouter route | https://mpp.tempo.xyz/openrouter/v1 | OpenAI-compatible chat completions |
| Tempo docs (accounts) | https://docs.tempo.xyz/guide/use-accounts | Passkeys, wallets, account creation |
| Tempo add funds | https://docs.tempo.xyz/guide/use-accounts/add-funds | Testnet faucet, balance verification |
| Tempo building with AI | https://docs.tempo.xyz/guide/building-with-ai | llms.txt, MCP, agent skills |
| OpenRouter pricing | https://openrouter.ai/pricing | Per-model, per-token pricing |

---

## 2. Expected Env Vars and Defaults

| Variable | Required | Default | Notes |
|---------|----------|---------|-------|
| `MPP_PRIVATE_KEY` | Yes (for MPP provider) | — | 0x-prefixed hex string; EVM private key |
| `HOMIE_MODEL_BASE_URL` | No | `https://mpp.tempo.xyz` | Override MPP proxy base URL |
| `MPPX_ACCOUNT` | No | — | mppx CLI: account name when using `mppx account` |
| `MPPX_RPC_URL` | No | Public RPC for chain | mppx CLI: RPC endpoint |

**homie.toml** (when `provider = "mpp"`):

```toml
[model]
provider = "mpp"
base_url = "https://mpp.tempo.xyz"  # optional override
default = "openai/gpt-4o"
fast = "openai/gpt-4o-mini"
```

---

## 3. First-Run Checks Users Need

1. **Key presence** – `MPP_PRIVATE_KEY` set and non-empty (already in `homie doctor`).
2. **Key format** – 0x-prefixed hex, 64 hex chars (66 total). homie validates on backend create.
3. **Wallet funded** – No built-in check today. First request will fail with payment/balance error if unfunded.
4. **Network** – mpp.tempo.xyz uses Tempo (testnet: rpc.moderato.tempo.xyz; mainnet TBD).
5. **mppx CLI** – Optional. `mppx account create` and `mppx account fund` help with wallet setup; homie uses `MPP_PRIVATE_KEY` directly, not mppx account store.

**Recommended first-run checks:**

- Validate `MPP_PRIVATE_KEY` format before any network call.
- Optionally: derive address from key, show truncated address (0x1234...5678) so user can verify.
- Optionally: probe MPP endpoint with a minimal request to confirm connectivity + payment flow (costs a tiny amount).

---

## 4. Wallet Creation Flow Recommendations

### Option A: mppx CLI (for mppx CLI usage only)

```bash
# 1. Create account (generates key, stores in system keychain)
mppx account create
# Output: Address 0x... — private key is NOT shown

# 2. Fund with testnet tokens (testnet only)
mppx account fund
```

**Important:** mppx stores the private key in the system keychain and does **not** expose it. homie requires `MPP_PRIVATE_KEY` in the environment. So:
- `mppx account create` is useful for testing `mppx <url>` directly.
- For homie, you must create a key via Option B and set `MPP_PRIVATE_KEY` in `.env`.

### Option B: Manual key creation (production-friendly)

```bash
# Using Foundry cast (if available)
cast wallet new

# Or: use any EVM keygen; output must be 0x-prefixed hex
```

### Option C: Dedicated low-balance wallet (security best practice)

1. Create a **new** wallet solely for MPP/homie.
2. Fund it with a small amount (e.g. $5–20 equivalent in stablecoins).
3. Never use a wallet holding significant funds.
4. Rotate keys if compromised; homie only needs the key, not recovery phrases.

---

## 5. Low-Balance Safety Patterns

| Pattern | Description |
|--------|-------------|
| **Dedicated wallet** | Use a separate wallet for MPP; limit exposure. |
| **Cap funding** | Fund with small amounts; top up as needed. |
| **Pre-flight check** | Optional: before first chat, verify balance via RPC (Tempo stablecoin balance). |
| **Graceful failure** | On payment failure (402, insufficient funds), show clear message: "Wallet balance too low. Add funds to 0x1234...5678" with link to faucet/docs. |
| **No auto-top-up** | Never prompt for or automate additional funding from main wallet. |
| **Usage visibility** | Log usage/cost per request when available (OpenRouter returns usage in response). |

**Tempo specifics:**

- No native gas token; fees paid in stablecoins (AlphaUSD, BetaUSD, ThetaUSD, pathUSD).
- Testnet faucet: `cast rpc tempo_fundAddress <ADDRESS> --rpc-url https://rpc.moderato.tempo.xyz`
- Mainnet: funding via DEX/bridge; no faucet.

---

## 6. Communicating Pay-Per-Use Costs in CLI

### Principles

1. **Upfront** – Before first use, state clearly: "MPP pays per request from your wallet. Each chat costs a few cents depending on model and length."
2. **Per-request** – Optionally show cost after each completion (e.g. "~$0.02" if usage available).
3. **Reference pricing** – Point to OpenRouter pricing page; e.g. "GPT-4o: ~$2.50/1M input, $10/1M output."
4. **No surprises** – Avoid silent failures; if payment fails, explain why and what to do.

### CLI Copy Examples

```
# On init (when MPP selected)
MPP pay-per-use: Requests are paid from your wallet (stablecoins).
Use a dedicated low-balance wallet. No API key required.

# Next steps
→ Set MPP_PRIVATE_KEY in .env (dedicated low-balance wallet)
→ Optional: run `mppx account create` then `mppx account fund` (testnet)
→ See https://openrouter.ai/pricing for model costs

# On first chat (optional banner)
Pay-per-use: Each message costs ~$0.01–0.10 depending on model. Balance paid from wallet.

# On payment failure
Wallet balance too low. Add funds to 0x1234...5678
Testnet: https://docs.tempo.xyz/guide/use-accounts/add-funds
```

---

## 7. Known Pitfalls

| Pitfall | Mitigation |
|---------|------------|
| **Key in git** | `.env` in `.gitignore`; never commit `MPP_PRIVATE_KEY`. |
| **Wrong key format** | Validate 0x + 64 hex chars; fail fast with clear error. |
| **Unfunded wallet** | First request fails; show actionable error with address and funding link. |
| **Mainnet vs testnet** | mpp.tempo.xyz may use mainnet; testnet uses different RPC. Clarify in docs. |
| **mppx account vs MPP_PRIVATE_KEY** | mppx stores keys internally; homie needs env var. Users may be confused—document both paths. |
| **Polyfilled fetch** | Mppx.Mppx.create() polyfills globalThis.fetch. Ensure no other code overwrites it during homie runtime. |

---

## 8. Proposed World-Class MPP Onboarding Sequence for `homie init`

### Phase 1: Provider selection (existing, enhanced)

When user selects MPP (quick start or custom):

1. Show **MPP info note** (already present):
   - No API key; pay from wallet
   - Use dedicated low-balance wallet
   - Endpoint: https://mpp.tempo.xyz/openrouter/v1

2. **Optional: Open docs** – "Open MPP docs in browser?" (already present)

3. **Wallet readiness check** (new):
   - If `MPP_PRIVATE_KEY` not set: add to next steps, suggest `mppx account create` or manual key creation
   - If set: validate format; optionally derive and show truncated address for verification

### Phase 2: Post-init next steps (enhanced)

For MPP, next steps should be:

1. Create a dedicated key: `cast wallet new` (Foundry) or any EVM keygen; save the 0x-prefixed hex output
2. Set `MPP_PRIVATE_KEY=<your_key>` in `.env`
3. Fund the wallet: testnet → `cast rpc tempo_fundAddress <YOUR_ADDRESS> --rpc-url https://rpc.moderato.tempo.xyz`
4. Run `homie doctor` to verify config
5. Run `homie chat` to test

Note: `mppx account create` stores keys in the system keychain and does not expose them; homie needs the key in env. Use manual key creation for homie.

### Phase 3: Doctor enhancements (optional)

- If MPP + key set: validate format, optionally show derived address
- If MPP + key invalid: clear error "Invalid MPP_PRIVATE_KEY: expected 0x-prefixed hex string"

### Phase 4: First-run / chat UX (optional)

- On first `homie chat` with MPP: one-time banner: "Pay-per-use: each message paid from wallet. See https://openrouter.ai/pricing for costs."
- On payment failure: specific error with address, funding link, and testnet vs mainnet guidance

### Phase 5: Cost visibility (optional, future)

- If OpenRouter usage returned: log or display approximate cost per completion
- e.g. `~$0.02 (1234 in / 567 out tokens)`

---

## Summary: Minimal vs Full Implementation

**Minimal (quick wins):**

- Validate `MPP_PRIVATE_KEY` format in doctor
- Improve next-steps copy with explicit wallet creation + funding steps
- Add cost-awareness note to init completion

**Full (world-class):**

- Derive address from key, show in init/doctor for verification
- Optional balance check before first chat (with clear "this may cost a few cents" warning)
- First-chat cost banner
- Specific payment-failure messaging with address and funding link
- Optional usage/cost display after completions
