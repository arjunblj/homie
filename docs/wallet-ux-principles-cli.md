# Wallet UX Principles for CLI Onboarding

Distilled from wagmi/viem, EIP-1193, SIWE (ERC-4361), WalletConnect, and EIP-3326. Principles are adapted for terminal setup flows where the user interacts via CLI rather than browser.

---

## 1. Connection State Model

### Wagmi / EIP-1193 Pattern

| Status | Meaning | CLI Equivalent |
|--------|---------|----------------|
| `disconnected` | No connection to any connector | No wallet configured or detected |
| `connecting` | Attempting to establish connection | Spinner / "Connecting to wallet..." |
| `reconnecting` | Attempting to re-establish connection | "Reconnecting..." (e.g. after session expiry) |
| `connected` | At least one connector is connected | Wallet address shown, ready for signing |

**EIP-1193 semantics**: Provider is either "connected" (can service RPC) or "disconnected" (cannot). Binary at the transport layer; wagmi adds `connecting`/`reconnecting` for UX.

### CLI Mapping

- **Expose status explicitly** – Don't leave the user guessing. Print `Connecting...`, `Connected as 0x1234...abcd`, or `Disconnected`.
- **Derived booleans** – Use `isConnecting`, `isConnected`, `isDisconnected` to gate commands (e.g. refuse signing when disconnected).
- **Narrow types** – When `status === 'connected'`, `address` is guaranteed; avoid optional chaining in that branch.

---

## 2. Chain / Network Mismatch Handling

### EIP-3326: `wallet_switchEthereumChain`

- Dapp/CLI requests chain switch via `chainId` (hex string).
- Wallet may accept or refuse; `null` on success, error otherwise.
- **Security**: Wallet should show confirmation identifying requester and target chain.

### Wagmi Error Types

- `ConnectorChainMismatchError` – Config out-of-sync with connector's active chain.
- `ChainNotConfiguredError` – Chain not in config; add it to supported chains.
- `SwitchChainNotSupportedError` – Connector doesn't support switching.

### CLI Principles

- **Detect mismatch early** – Before signing, compare expected chain vs. wallet chain.
- **Contextual messages** – e.g. "Network not supported. Please switch to Ethereum Mainnet" (WalletConnect).
- **Offer switch** – If possible, prompt: "Switch to chain X? (y/n)" and call `wallet_switchEthereumChain` or equivalent.
- **Don't fail silently** – Surface chain mismatch as a clear error, not a generic "signing failed".

---

## 3. Account Display and Truncation

### Conventions

| Format | Use Case | Example |
|--------|----------|---------|
| `0x1234...5678` | Standard truncation (first 4 + last 4) | Wallets, explorers, UIs |
| `0x0{18}44...` | ERC-8117 ASCII mode (CLI/logs) | Terminals, logs, copy-paste |
| `0x0¹⁸44...` | ERC-8117 Unicode mode | Rich UIs, mobile |

### Rules

- **Preserve EIP-55 checksum** – Non-compressed chars keep original casing.
- **Trigger compression** – Only when sequence of identical hex chars ≥ 6 (ERC-8117).
- **CLI default** – Use ASCII truncation: `0x1234...5678` or `0x0{18}44...` for vanity addresses.

### CLI Mapping

- Short form: `0x${addr.slice(2, 6)}...${addr.slice(-4)}` (4 + 4).
- For vanity addresses with long runs: consider ERC-8117 Mode B (`0x0{18}44...`).
- Always show enough context for user to verify (avoid homoglyph confusion).

---

## 4. Signing / Consent Language (SIWE)

### ERC-4361 Structure

```
{domain} wants you to sign in with your Ethereum account:
{address}

{statement}

URI: {uri}
Version: 1
Chain ID: {chain-id}
Nonce: {nonce}
Issued At: {issued-at}
[Expiration Time: ...]
[Resources: ...]
```

### Principles

- **Structured plaintext** – Human-readable, not raw JSON/hex.
- **Statement** – Optional; use for consent: "I accept the ServiceOrg Terms of Service".
- **Domain binding** – Bind to requester (e.g. CLI tool name, host) to prevent phishing.
- **Nonce** – Required; prevents replay.
- **Expiration** – Optional but recommended for session limits.

### CLI Mapping

- **Before signing**: Print the full message (or key fields) so the user can read it.
- **Consent phrasing**: Use "wants you to sign in with your Ethereum account" or equivalent.
- **Scroll-to-sign** (browser): N/A in CLI; instead require explicit confirmation: "Sign this message? (y/n)".
- **Display fields**: At minimum show `domain`, `address`, `statement`, `resources` if present.

---

## 5. Error Messaging and Retry UX

### WalletConnect Best Practices

- **Specific over generic** – "Network not supported. Please switch to Ethereum Mainnet" vs "Connection failed".
- **Bidirectional feedback** – Inform both user and caller (dapp/CLI) so state can update.
- **Loading indicators** – Show progress during connect/sign; remove when done.
- **Latency targets** – Connection: &lt;5s normal, &lt;15s poor network; Signing: &lt;5s normal, &lt;10s poor.

### WalletConnect Error Codes (Representative)

| Code | Category | Example |
|------|----------|---------|
| 4001 | EIP-1193 | User rejected request |
| 5000–5104 | Rejected | User rejected chains/methods, unsupported chains, etc. |
| 6000 | Reason | User disconnected |
| 7000–7001 | Failure | Session settlement failed, no session |
| 8000 | Session | Request expired |

### Wagmi Error Discrimination

- Use `error?.name` to branch: `HttpRequestError`, `ConnectorNotFoundError`, `ConnectorChainMismatchError`, etc.
- Strongly typed errors enable granular handling.

### Retry Patterns

- **useReconnect** – Explicit reconnect action; supports `retry`, `retryDelay`, `onError`, `onSuccess`.
- **Exponential backoff** – `attempt => Math.min(2 ** attempt * 1000, 30000)`.
- **reconnectOnMount** – Auto-retry on startup (CLI: on `init` or first command).

### CLI Mapping

- **Classify errors** – Map to user-facing messages: "User rejected", "Connection timeout", "Wrong network", "Session expired".
- **Retry affordance** – After failure, prompt: "Retry? (y/n)" or "Run `homie connect` to try again."
- **Timeout handling** – If &gt;15s with no response, show "Connection timed out. Check your wallet and network, then retry."
- **User rejection** – Don't treat as error; treat as normal flow: "Signing cancelled."

---

## Summary: CLI Onboarding Checklist

1. **Connection state** – Always show one of: disconnected / connecting / connected / error.
2. **Chain mismatch** – Detect, explain, and offer switch before signing.
3. **Address display** – Use `0x1234...5678`; consider ERC-8117 for vanity addresses in logs.
4. **Signing consent** – Show structured message, use SIWE-style phrasing, require explicit confirm.
5. **Errors** – Specific messages, retry option, distinguish user rejection from real failures.
6. **Latency** – Show progress; consider 5–15s timeouts and clear timeout messaging.
