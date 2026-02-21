# Tempo Protocol - Exhaustive Documentation Research

## Table of Contents

1. [Network Overview](#1-network-overview)
2. [Account Model](#2-account-model)
3. [Tempo Transaction Type (0x76)](#3-tempo-transaction-type-0x76)
4. [Account Keychain Precompile](#4-account-keychain-precompile)
5. [Access Key Authorization Flow](#5-access-key-authorization-flow)
6. [Spending Limit Mechanics](#6-spending-limit-mechanics)
7. [Fee System](#7-fee-system)
8. [Fee Sponsorship](#8-fee-sponsorship)
9. [TIP-20 Token Standard](#9-tip-20-token-standard)
10. [Signature Types](#10-signature-types)
11. [Parallelizable Nonces (2D Nonces)](#11-parallelizable-nonces-2d-nonces)
12. [Testnet Details](#12-testnet-details)
13. [SDKs & Developer Tools](#13-sdks--developer-tools)
14. [Server Handlers](#14-server-handlers)
15. [Predeployed Contracts](#15-predeployed-contracts)
16. [Gas Costs Reference](#16-gas-costs-reference)
17. [Code Examples](#17-code-examples)

---

## 1. Network Overview

Tempo is a general-purpose blockchain optimized for payments. Purpose-built for stablecoin use cases.

- **Consensus**: Simplex BFT with permissioned validator set at launch
- **Finality**: Deterministic (not probabilistic like Ethereum)
- **Block time**: ~0.5 seconds
- **EVM target**: Osaka hard fork
- **No native gas token** - fees paid in USD-denominated stablecoins
- **Currency symbol**: `USD`
- **Open source**: Apache license, GitHub at `github.com/tempoxyz`

### Key Differentiators

- No native token (no ETH equivalent)
- Fees denominated in attodollars (10^-18 USD per gas)
- TIP-20 transfer costs < $0.001
- Base fee: 20 billion attodollars per gas (2 × 10^10)
- A standard TIP-20 transfer (~50,000 gas) ≈ $0.001

---

## 2. Account Model

### Account Types

Tempo supports two primary account creation options:

#### Passkey Accounts (Domain-Bound)
- WebAuthn signatures for secure, passwordless authentication
- Biometric support: fingerprint, Face ID, Touch ID
- Keys stored in device's secure enclave
- Sync across devices via iCloud Keychain or Google Password Manager
- **Domain-bound**: credentials only work on the domain (Relying Party) they were created for
- Address derived from P256 public key: `keccak256(pub_key_x || pub_key_y)[12:32]`

#### Wallet Accounts (Universal)
- Standard EVM-compatible wallets (MetaMask, etc.)
- secp256k1 signature scheme
- Standard Ethereum address derivation: `keccak256(uncompressed_public_key)[12:32]`

### Address Derivation

| Key Type | Derivation |
|----------|-----------|
| secp256k1 | `address(uint160(uint256(keccak256(abi.encode(x, y)))))` |
| P256 | `keccak256(pub_key_x \|\| pub_key_y)[12:32]` |
| WebAuthn | Same as P256 (shared address space) |

P256 and WebAuthn use identical address derivation, so the same key pair produces the same address regardless of signature type.

---

## 3. Tempo Transaction Type (0x76)

New EIP-2718 transaction type with type byte `0x76`. Supports:

- **Access Keys** - scoped keys with spending limits
- **Scheduled Txs** - time-window execution (valid_before / valid_after)
- **Call Batching** - atomic multicall
- **Gas sponsorship** - third-party fee payment
- **Parallelizable nonces** - 2D nonce for concurrent tx submission
- **WebAuthn/P256 signature validation** - passkey accounts

### Transaction Structure

```rust
pub struct TempoTransaction {
    chain_id: ChainId,
    max_priority_fee_per_gas: u128,
    max_fee_per_gas: u128,
    gas_limit: u64,
    calls: Vec<Call>,                            // Batch of calls (atomic)
    access_list: AccessList,

    // Nonce fields
    nonce_key: U256,                             // 2D nonce key (0 = protocol, >0 = user)
    nonce: u64,

    // Optional features
    fee_token: Option<Address>,                  // Fee token preference
    fee_payer_signature: Option<Signature>,       // Sponsored tx (secp256k1 only)
    valid_before: Option<u64>,                   // Expiration timestamp
    valid_after: Option<u64>,                    // Earliest inclusion timestamp
    key_authorization: Option<SignedKeyAuthorization>, // Access key auth
    aa_authorization_list: Vec<TempoSignedAuthorization>, // EIP-7702 style
}

pub struct Call {
    to: TxKind,
    value: U256,
    input: Bytes,
}
```

### RLP Encoding

```
0x76 || rlp([
    chain_id,
    max_priority_fee_per_gas,
    max_fee_per_gas,
    gas_limit,
    calls,
    access_list,
    nonce_key,
    nonce,
    valid_before,            // 0x80 if None
    valid_after,             // 0x80 if None
    fee_token,               // 0x80 if None
    fee_payer_signature,     // 0x80 if None
    aa_authorization_list,
    key_authorization?,      // Only encoded if present
    sender_signature
])
```

---

## 4. Account Keychain Precompile

**Address**: `0xAAAAAAAA00000000000000000000000000000000`

Manages authorized Access Keys for accounts. Enables Root Keys (e.g. passkeys) to provision scoped secondary keys.

### Concepts

**Root Key** (keyId = address(0)):
- The account's primary key (address matches account address)
- No spending limits
- Can call ALL precompile functions
- Can authorize, revoke, and update Access Keys

**Access Keys** (keyId != address(0)):
- Secondary keys authorized by Root Key
- Can have expiry timestamps
- Subject to per-TIP20 token spending limits
- CANNOT call mutable precompile functions (authorizeKey, revokeKey, updateSpendingLimit)

### Interface

```solidity
interface IAccountKeychain {
    enum SignatureType { Secp256k1, P256, WebAuthn }

    struct TokenLimit {
        address token;
        uint256 amount;
    }

    struct KeyInfo {
        SignatureType signatureType;
        address keyId;
        uint64 expiry;          // 0 = never expires
        bool enforceLimits;
        bool isRevoked;
    }

    // Management (Root Key only)
    function authorizeKey(
        address keyId,
        SignatureType signatureType,
        uint64 expiry,
        bool enforceLimits,
        TokenLimit[] calldata limits
    ) external;

    function revokeKey(address keyId) external;

    function updateSpendingLimit(
        address keyId,
        address token,
        uint256 newLimit
    ) external;

    // View functions (anyone)
    function getKey(address account, address keyId) external view returns (KeyInfo memory);
    function getRemainingLimit(address account, address keyId, address token) external view returns (uint256);
    function getTransactionKey() external view returns (address);

    // Events
    event KeyAuthorized(address indexed account, address indexed publicKey, uint8 signatureType, uint64 expiry);
    event KeyRevoked(address indexed account, address indexed publicKey);
    event SpendingLimitUpdated(address indexed account, address indexed publicKey, address indexed token, uint256 newLimit);

    // Errors
    error KeyAlreadyExists();
    error KeyNotFound();
    error KeyInactive();
    error KeyExpired();
    error KeyAlreadyRevoked();
    error SpendingLimitExceeded();
    error InvalidSignatureType();
    error ZeroPublicKey();
    error UnauthorizedCaller();
}
```

### Storage Layout

AuthorizedKey (packed into single slot):
- byte 0: signature_type (u8)
- bytes 1-8: expiry (u64, little-endian)
- byte 9: enforce_limits (bool)
- byte 10: is_revoked (bool)

Spending limits: `spendingLimits[keccak256(account || keyId)][token]` → remaining amount (uint256)

Transaction key: transient storage at slot 0 for current tx's signing key ID.

### Key Behaviors

**Authorization rules:**
- keyId MUST NOT be address(0)
- keyId MUST NOT have been previously revoked (prevents replay attacks)
- keyId MUST NOT already be authorized with expiry > 0
- MUST be called by Root Key (transactionKey[msg.sender] == 0)

**Revocation rules:**
- Once revoked, a keyId can NEVER be re-authorized for this account (replay attack prevention)
- Sets isRevoked = true, expiry = 0

**Spending limit update:**
- Setting new limit REPLACES current remaining amount (not additive)
- If key had unlimited spending (enforceLimits == false), this enables limits
- Limits do NOT reset automatically (no time-based periods)

---

## 5. Access Key Authorization Flow

### KeyAuthorization Structure

```rust
pub struct KeyAuthorization {
    chain_id: u64,                    // 0 = valid on any chain
    key_type: SignatureType,          // Secp256k1(0), P256(1), WebAuthn(2)
    key_id: Address,                  // Address derived from public key
    expiry: Option<u64>,             // Unix timestamp, None = never expires
    limits: Option<Vec<TokenLimit>>, // None = unlimited spending
}

pub struct SignedKeyAuthorization {
    authorization: KeyAuthorization,
    signature: PrimitiveSignature,   // Root key signs keccak256(rlp(authorization))
}

pub struct TokenLimit {
    token: Address,                  // TIP20 token address
    limit: U256,                     // Maximum spending amount
}
```

### First-Time Authorization (Authorize + Use in One Tx)

```typescript
// 1. Generate Access Key
const accessKey = generateKeyPair('p256');
const keyId = deriveAddress(accessKey.publicKey);

// 2. Create Authorization
const keyAuth = {
  chain_id: 42431,
  key_type: 1,       // P256
  key_id: keyId,
  expiry: timestamp + 86400,  // 24 hours
  limits: [
    { token: USDC_ADDRESS, amount: 1000000000 }, // 1000 USDC (6 dec)
  ]
};

// 3. Root Key signs authorization digest
const authDigest = keccak256(rlp([chain_id, key_type, key_id, expiry, limits]));
const rootSignature = await signWithRootKey(authDigest);

// 4. Build TempoTransaction with key_authorization
const tx = {
  chain_id: 42431,
  nonce: await getNonce(account),
  calls: [{ to: recipient, value: 0, input: '0x' }],
  gas_limit: 200000,
  key_authorization: {
    ...keyAuth,
    signature: rootSignature
  },
};

// 5. Access Key signs the transaction itself
const txHash = computeTxSignatureHash(tx);
const accessSignature = await signWithAccessKey(txHash, accessKey);
const finalSignature = {
  Keychain: {
    user_address: account,
    signature: { P256: accessSignature }
  }
};
```

### Subsequent Usage (Key Already Authorized)

```typescript
const tx = {
  chain_id: 42431,
  nonce: await getNonce(account),
  calls: [{ to: recipient, value: 0, input: calldata }],
  key_authorization: null,  // No authorization needed
};

const finalSignature = {
  Keychain: {
    user_address: account,
    signature: { P256: await signWithAccessKey(txHash, accessKey) }
  }
};
```

### Protocol Validation Steps

1. Identifies signing key from transaction signature
   - Keychain variant → extracts keyId of Access Key
   - Otherwise → Root Key (keyId = address(0))
2. Validates KeyAuthorization (if present) — provisions new key
   - Access Key being authorized CAN sign the same tx (authorize + use in one tx)
3. Sets transactionKey[account] = keyId in protocol state
4. Validates key authorization for Access Keys:
   - Checks key is active (not revoked)
   - Checks expiry: `current_timestamp < expiry`
5. Enforces spending limits during execution

---

## 6. Spending Limit Mechanics

### Scope of Enforcement

Spending limits ONLY apply to these TIP20 direct calls:
- `transfer(to, amount)`
- `transferWithMemo(to, amount, memo)`
- `approve(spender, amount)` (only increases in approval count)
- `startReward(amount, seconds)`

**NOT limited:**
- `transferFrom()` (contract calls on behalf of user)
- Native value transfers
- NFT transfers
- Any call where `msg.sender != tx.origin`

### How Limits Work

1. Protocol intercepts TIP20 method calls during execution
2. Queries `getRemainingLimit(account, keyId, token)`
3. For `transfer`/`transferWithMemo`: checks `amount <= remaining_limit`
4. For `approve`: checks `increase_amount <= remaining_limit` (new - previous allowance)
5. If check passes: decrements limit by amount
6. If check fails: reverts with `SpendingLimitExceeded`

### Limit Updates (Root Key Only)

```typescript
// Updates via precompile call
const tx = {
  calls: [{
    to: '0xAAAAAAAA00000000000000000000000000000000',
    value: 0,
    input: encodeCall('updateSpendingLimit', [keyId, USDC_ADDRESS, 2000000000])
  }],
  // Must be signed by Root Key
};
```

- Setting new limit REPLACES current remaining (not additive)
- Limits deplete as spent, do NOT auto-reset
- Root Key has no limits (skipped entirely)

---

## 7. Fee System

### No Native Token

Tempo has NO native gas token. Fees paid in USD-denominated stablecoins.

- Fee units: **attodollars** (10^-18 USD) per gas
- TIP-20 tokens have 6 decimals (1 unit = 1 microdollar = 10^-6 USD)
- Conversion: `fee = ceil(base_fee * gas_used / 10^12)`
- Base fee: `2 × 10^10` attodollars/gas (fixed, not EIP-1559 variable)

### Fee Token Preference Cascade

Priority order (first match wins):

| Priority | Level | Description |
|----------|-------|------------|
| 1 | **Transaction** | `fee_token` field in TempoTransaction |
| 2 | **Account** | Set via `FeeManager.setUserToken()` |
| 3 | **TIP-20 Contract** | If calling transfer/transferWithMemo/startReward on a TIP-20 |
| 4 | **Stablecoin DEX** | For swap calls, uses tokenIn |
| 5 | **pathUSD fallback** | Default: `0x20c0000000000000000000000000000000000000` |

At each level, validation checks:
- Token is a TIP-20 with currency == "USD"
- User has sufficient balance
- Fee AMM has sufficient liquidity (if conversion needed)

### Fee Payment Lifecycle

1. **Pre-execution**: Deduct `max_fee = gas_limit * gas_price` from fee_payer
2. **Execution**: Transaction runs
3. **Post-execution**: Refund `(gas_limit - gas_used) * gas_price`
4. **Conversion**: If user's token ≠ validator's token, Fee AMM converts at 0.9970 rate (0.3% to LPs)

### FeeManager Precompile

Address: `0xfeec000000000000000000000000000000000000`

```typescript
// Set user's default fee token
await client.fee.setUserTokenSync({ token: '0x20c0...0001' });

// Get user's fee token
const feeToken = await client.fee.getUserToken({ account: userAddress });
```

---

## 8. Fee Sponsorship

A third party (fee payer) can pay transaction fees on behalf of the sender.

### Dual Signature Domain Separation

- **Sender** signs with type byte `0x76`
- **Fee Payer** signs with magic byte `0x78`
- Different magic bytes prevent signature reuse attacks

### Sender Signature (when sponsored)

```rust
// fee_token encoded as EMPTY (delegated to fee payer)
// fee_payer_signature = 0x00 (placeholder)
sender_hash = keccak256(0x76 || rlp([
    chain_id, max_priority_fee_per_gas, max_fee_per_gas,
    gas_limit, calls, access_list, nonce_key, nonce,
    valid_before, valid_after,
    0x80,  // fee_token EMPTY
    0x00   // placeholder
]))
```

### Fee Payer Signature

```rust
fee_payer_hash = keccak256(0x78 || rlp([
    chain_id, max_priority_fee_per_gas, max_fee_per_gas,
    gas_limit, calls, access_list, nonce_key, nonce,
    valid_before, valid_after,
    fee_token,        // ALWAYS included
    sender_address,   // Commits to specific sender
    key_authorization,
]))
```

### Fee Payer Rules

- Fee payer signature: **secp256k1 only** (initially)
- Fee payer must have sufficient balance in fee_token
- Fee payer commits to: specific fee token + specific sender

### Sponsorship Flow

1. User prepares tx with `fee_payer_signature = placeholder`
2. User signs (with fee_token skipped from their hash)
3. Fee payer receives user-signed tx, verifies user sig
4. Fee payer signs (with fee_token and sender_address)
5. Transaction broadcast with both signatures

---

## 9. TIP-20 Token Standard

Precompiled token contracts in the core protocol. Extends ERC-20 with:

- **32-byte memo support** on transfers, mints, burns
- **Role-based access control** (ISSUER_ROLE, PAUSE_ROLE, etc.)
- **Transfer policies** via TIP-403 registry
- **Reward distribution** (opt-in proportional distribution)
- **Supply caps**
- **Compliance controls** (blocklist/allowlist via policies)

### Decimals

All TIP-20 tokens use **6 decimals** (1 token = 1,000,000 units).

### Key Functions Beyond ERC-20

```solidity
// Memo transfers
function transferWithMemo(address to, uint256 amount, bytes32 memo) external;
function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo) external returns (bool);

// Memo mint/burn
function mintWithMemo(address to, uint256 amount, bytes32 memo) external;
function burnWithMemo(uint256 amount, bytes32 memo) external;

// Compliance
function burnBlocked(address from, uint256 amount) external; // Burn from blocked address

// Config
function quoteToken() external view returns (ITIP20);
function currency() external view returns (string memory);
function paused() external view returns (bool);
function transferPolicyId() external view returns (uint64);
```

### TIP20Factory

Address: `0x20Fc000000000000000000000000000000000000`

```solidity
function createToken(
    string memory name,
    string memory symbol,
    string memory currency,   // ISO 4217 code, e.g. "USD"
    ITIP20 quoteToken,
    address admin,
    bytes32 salt
) external returns (address token);
```

Token addresses: deterministic, prefix `0x20C0...` + 8 bytes from `keccak256(msg.sender, salt)`.

### Roles

| Role | Capability |
|------|-----------|
| DEFAULT_ADMIN_ROLE | Manage roles, config, transfer policies |
| ISSUER_ROLE | Mint and burn tokens |
| PAUSE_ROLE | Pause the contract |
| UNPAUSE_ROLE | Unpause the contract |
| BURN_BLOCKED_ROLE | Burn tokens from blocked addresses |

---

## 10. Signature Types

### Detection by Length

| Type | Length | Type ID | Description |
|------|--------|---------|------------|
| secp256k1 | 65 bytes | None | Standard Ethereum (r, s, v) |
| P256 | 130 bytes | `0x01` | NIST P-256 curve + public key |
| WebAuthn | Variable (129-2049) | `0x02` | WebAuthn authenticator data + P256 |
| Keychain | Variable | `0x03` | Wrapper: user_address + inner signature |

### Keychain Signature Format

```rust
pub struct KeychainSignature {
    typeId: u8,                     // 0x03
    user_address: Address,          // 20 bytes - root account address
    signature: PrimitiveSignature   // Inner: Secp256k1, P256, or WebAuthn
}
```

Allows an Access Key to sign on behalf of a root account. Handler validates `user_address` has authorized the access key in the AccountKeychain precompile.

---

## 11. Parallelizable Nonces (2D Nonces)

### Structure

- `nonce_key: U256` — the nonce "lane"
- `nonce: u64` — sequence within that lane

### Rules

| Key | Behavior |
|-----|---------|
| 0 (protocol) | Standard sequential nonce, stored in account state |
| 1-N (user) | Independent parallel lanes, stored in Nonce precompile |
| 0x5b... (reserved) | Reserved for sub-block transactions |

### Nonce Precompile

Address: `0x4E4F4E4345000000000000000000000000000000` (ASCII "NONCE")

```solidity
interface INonce {
    function getNonce(address account, uint256 nonceKey) external view returns (uint64 nonce);
    event NonceIncremented(address indexed account, uint256 indexed nonceKey, uint64 newNonce);
}
```

Storage: `keccak256(abi.encode(account_address, nonce_key))` → nonce value.

### Gas for Nonce Keys

| Case | Additional Gas |
|------|---------------|
| Protocol nonce (key 0) | 0 |
| Existing user key (nonce > 0) | 5,000 |
| New user key (nonce == 0) | 22,100 |

---

## 12. Testnet Details

### Moderato Testnet

| Property | Value |
|----------|-------|
| Network Name | Tempo Testnet (Moderato) |
| Currency | `USD` |
| Chain ID | `42431` |
| HTTP RPC | `https://rpc.moderato.tempo.xyz` |
| WebSocket | `wss://rpc.moderato.tempo.xyz` |
| Block Explorer | `https://explore.tempo.xyz` |

### Mainnet (Upcoming)

| Property | Value |
|----------|-------|
| Chain ID | `4217` |

### Faucet Tokens

| Asset | Address | Amount |
|-------|---------|--------|
| pathUSD | `0x20c0000000000000000000000000000000000000` | 1M |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` | 1M |
| BetaUSD | `0x20c0000000000000000000000000000000000002` | 1M |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` | 1M |

Fund via Foundry:
```bash
cast rpc tempo_fundAddress <YOUR_ADDRESS> --rpc-url https://rpc.moderato.tempo.xyz
```

### EVM Differences

| Feature | Tempo | Ethereum |
|---------|-------|----------|
| eth_getBalance | Returns huge placeholder | Actual ETH balance |
| BALANCE / SELFBALANCE opcodes | Always return 0 | Actual balance |
| CALLVALUE | Always return 0 | msg.value |
| New storage slot (SSTORE) | 250,000 gas | 20,000 gas |
| Account creation | 250,000 gas | 0 gas |
| Contract creation per byte | 1,000 gas | 200 gas |

---

## 13. SDKs & Developer Tools

### TypeScript (Viem + Wagmi)

- `viem/tempo` — actions, chains, utilities (upstreamed from tempo.ts)
- `wagmi/tempo` — React hooks (upstreamed from tempo.ts)
- `viem/chains` — chain definitions including `tempoModerato`

```typescript
import { createConfig, http } from 'wagmi';
import { tempoModerato } from 'viem/chains';
import { KeyManager, webAuthn } from 'wagmi/tempo';

export const config = createConfig({
  chains: [tempoModerato],
  connectors: [webAuthn({
    keyManager: KeyManager.localStorage(), // Dev only
    // keyManager: KeyManager.http('https://api.example.com/keys'), // Production
  })],
  transports: {
    [tempoModerato.id]: http(),
  },
});
```

### Go SDK

```bash
go get github.com/tempoxyz/tempo-go@v0.1.0
```

Packages: `transaction`, `client`, `signer`

### Foundry (Tempo Fork)

```bash
foundryup -n tempo
forge init -n tempo my-project
```

Tempo-specific CLI flags:
- `--tempo.fee-token <addr>` — specify fee token
- `--tempo.nonce-key <key>` — 2D nonce key
- `--tempo.expiring-nonce` — time-bounded tx
- `--tempo.valid-before <timestamp>` — tx expiration
- `--tempo.sponsor-signature <sig>` — gasless tx
- `--tempo.print-sponsor-hash` — get fee payer hash

### Rust SDK

`tempo-alloy` crate

### Python SDK

`pytempo` — `github.com/tempoxyz/pytempo`

### MCP Server

```json
{
  "mcpServers": {
    "tempo-docs": {
      "url": "https://docs.tempo.xyz/api/mcp"
    }
  }
}
```

---

## 14. Server Handlers

Framework-agnostic handlers from `tempo.ts/server`. Compatible with Node.js, Bun, Deno, Express, Hono, Next.js.

### Handler.feePayer

Subsidize gas costs for users. Server-side fee payer signing.

```typescript
import { Handler } from 'tempo.ts/server';
import { tempoModerato } from 'viem/chains';
import { http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const handler = Handler.feePayer({
  account: privateKeyToAccount('0x...'),
  chain: tempoModerato.extend({ feeToken: '0x20c0...0001' }),
  path: '/fee-payer',
  transport: http(),
});
```

Client-side usage:

```typescript
import { withFeePayer } from 'viem/tempo';

const client = createClient({
  chain: tempoModerato,
  transport: withFeePayer(
    http(),
    http('http://localhost:3000/fee-payer'),
  ),
}).extend(tempoActions());

await client.token.transferSync({
  amount: parseUnits('10', 6),
  feePayer: true,
  to: '0x...',
  token: '0x20c0...0001',
});
```

### Handler.keyManager

Manages WebAuthn credential public keys for cross-device passkey access.

```typescript
import { Handler, Kv } from 'tempo.ts/server';

const handler = Handler.keyManager({
  kv: Kv.memory(),        // Dev only; use Cloudflare KV, Redis, etc. in prod
  path: '/keys',
  rp: 'example.com',
});
```

Endpoints:
- `GET /keys/challenge` — generate WebAuthn challenge
- `GET /keys/:credentialId` — retrieve public key
- `POST /keys/:credentialId` — store new credential

### Handler.compose

Combine handlers into a single endpoint:

```typescript
const handler = Handler.compose([
  Handler.feePayer({ path: '/fee-payer', ... }),
  Handler.keyManager({ path: '/keys', ... }),
], { path: '/api' });

// Routes: POST /api/fee-payer, GET /api/keys/challenge, etc.
```

Server framework adapters:

```typescript
createServer(handler.listener)              // Node.js
Bun.serve(handler)                          // Bun
Deno.serve(handler)                         // Deno
app.all('*', c => handler.fetch(c.request)) // Elysia
app.use(handler.listener)                   // Express
app.use(c => handler.fetch(c.req.raw))      // Hono
export const GET = handler.fetch            // Next.js
export const POST = handler.fetch           // Next.js
```

---

## 15. Predeployed Contracts

### System Contracts

| Contract | Address |
|----------|---------|
| TIP-20 Factory | `0x20fc000000000000000000000000000000000000` |
| Fee Manager | `0xfeec000000000000000000000000000000000000` |
| Stablecoin DEX | `0xdec0000000000000000000000000000000000000` |
| TIP-403 Registry | `0x403c000000000000000000000000000000000000` |
| Account Keychain | `0xAAAAAAAA00000000000000000000000000000000` |
| Nonce Precompile | `0x4E4F4E4345000000000000000000000000000000` |
| pathUSD | `0x20c0000000000000000000000000000000000000` |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` |
| BetaUSD | `0x20c0000000000000000000000000000000000002` |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` |

### Standard Utilities

| Contract | Address |
|----------|---------|
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| CreateX | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |
| Arachnid Create2 | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |

### ABIs

```typescript
import { Abis } from 'viem/tempo';
const tip20Abi = Abis.tip20;
const tip20FactoryAbi = Abis.tip20Factory;
const stablecoinDexAbi = Abis.stablecoinDex;
const feeManagerAbi = Abis.feeManager;
const feeAmmAbi = Abis.feeAmm;
```

---

## 16. Gas Costs Reference

### Signature Verification

| Type | Base Gas | Notes |
|------|---------|-------|
| secp256k1 | 21,000 | Standard (includes 3,000 for ecrecover) |
| P256 | 26,000 | +5,000 for P256 verification |
| WebAuthn | 26,000 + variable | +clientDataJSON calldata gas |
| Keychain | Inner sig + 3,000 | Key validation overhead |

### Key Authorization (Intrinsic Gas)

| Component | Gas |
|-----------|-----|
| secp256k1 sig verification | 3,000 |
| P256 sig verification | 8,000 |
| Key storage | 22,000 |
| Overhead buffer | 5,000 |
| Per spending limit | 22,000 each |

Formula: `total = sig_cost + 22,000 + 5,000 + (num_limits × 22,000)`

Examples:
- secp256k1, no limits: 30,000 gas
- secp256k1, 1 limit: 52,000 gas
- P256, 2 limits: 79,000 gas

### Network Gas Parameters

| Parameter | Value |
|-----------|-------|
| Base fee | 2 × 10^10 attodollars/gas |
| Block gas limit (total) | 500M gas |
| General gas limit | 30M gas/block |
| TIP-20 transfer gas | ~50,000 gas ≈ $0.001 |

---

## 17. Code Examples

### Go: Send Transaction with Fee Sponsorship

```go
tx := transaction.NewBuilder(big.NewInt(42431)).
    SetNonce(nonce).
    SetGas(100000).
    SetMaxFeePerGas(big.NewInt(20000000000)).
    SetMaxPriorityFeePerGas(big.NewInt(1000000000)).
    SetSponsored(true).
    AddCall(recipient, big.NewInt(0), data).
    Build()

transaction.SignTransaction(tx, userSigner)
transaction.AddFeePayerSignature(tx, feePayerSigner)
```

### Go: Parallel Transactions (2D Nonces)

```go
tx1 := transaction.NewBuilder(big.NewInt(42431)).
    SetNonceKey(big.NewInt(1)).  // Lane A
    SetNonce(0).
    AddCall(recipient1, big.NewInt(0), data1).
    Build()

tx2 := transaction.NewBuilder(big.NewInt(42431)).
    SetNonceKey(big.NewInt(2)).  // Lane B (parallel)
    SetNonce(0).
    AddCall(recipient2, big.NewInt(0), data2).
    Build()
```

### Go: Token Transfer with Memo

```go
tip20ABI, _ := abi.JSON(strings.NewReader(`[{"name":"transferWithMemo","type":"function","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"},{"name":"memo","type":"bytes32"}]}]`))

recipient := common.HexToAddress("0x...")
amount := big.NewInt(100_000_000) // 100 tokens (6 decimals)
memo := [32]byte{}
copy(memo[:], "INV-12345")
memoData, _ := tip20ABI.Pack("transferWithMemo", recipient, amount, memo)
```

### Foundry: Authorize Access Key via CLI

```bash
# Authorize an access key
cast send 0xAAAAAAAA00000000000000000000000000000000 \
  'authorizeKey(address,uint8,uint64,bool,(address,uint256)[])' \
  $ACCESS_KEY_ADDR 0 1893456000 false "[]" \
  --rpc-url $TEMPO_RPC_URL \
  --private-key $ROOT_PRIVATE_KEY

# Send using access key
cast send <CONTRACT> 'increment()' \
  --rpc-url $TEMPO_RPC_URL \
  --access-key $ACCESS_KEY_PRIVATE_KEY \
  --root-account $ROOT_ADDRESS
```

### Foundry: Sponsored Transaction via CLI

```bash
# Step 1: Get fee payer hash
FEE_PAYER_HASH=$(cast mktx <CONTRACT> 'increment()' \
  --rpc-url $TEMPO_RPC_URL \
  --private-key $SENDER_KEY \
  --tempo.print-sponsor-hash)

# Step 2: Sponsor signs
SPONSOR_SIG=$(cast wallet sign --private-key $SPONSOR_KEY "$FEE_PAYER_HASH" --no-hash)

# Step 3: Send with sponsor
cast send <CONTRACT> 'increment()' \
  --rpc-url $TEMPO_RPC_URL \
  --private-key $SENDER_KEY \
  --tempo.sponsor-signature "$SPONSOR_SIG"
```

### TypeScript: Wagmi Passkey Setup

```typescript
import { createConfig, http } from 'wagmi';
import { tempoModerato } from 'viem/chains';
import { KeyManager, webAuthn } from 'wagmi/tempo';

export const config = createConfig({
  chains: [tempoModerato],
  connectors: [webAuthn({
    keyManager: KeyManager.http('https://api.example.com/keys'),
    rpId: 'example.com',
  })],
  multiInjectedProviderDiscovery: false,
  transports: {
    [tempoModerato.id]: http(),
  },
});
```

### TypeScript: Fee-Sponsored Transfer (Viem)

```typescript
import { createClient, http, walletActions } from 'viem';
import { tempoModerato } from 'viem/chains';
import { tempoActions, withFeePayer } from 'viem/tempo';

const client = createClient({
  chain: tempoModerato,
  transport: withFeePayer(
    http(),
    http('http://localhost:3000/fee-payer'),
  ),
}).extend(tempoActions());

const receipt = await client.token.transferSync({
  amount: parseUnits('10', 6),
  feePayer: true,
  to: '0x...',
  token: '0x20c0000000000000000000000000000000000001',
});
```

### TypeScript: Create Stablecoin (Wagmi)

```typescript
import { Hooks } from 'wagmi/tempo';

function CreateStablecoin() {
  const create = Hooks.token.useCreateSync();

  const handleCreate = (name: string, symbol: string) => {
    create.mutate({ name, symbol, currency: 'USD' });
  };
}
```

### TypeScript: Query Key State

```typescript
const keyInfo = await precompile.getKey(account, keyId);
// Returns: { signatureType, keyId, expiry, enforceLimits, isRevoked }

const remaining = await precompile.getRemainingLimit(account, keyId, USDC_ADDRESS);
// Returns: uint256 remaining amount

const currentKey = await precompile.getTransactionKey();
// Returns: address (0x0 for Root Key, keyId for Access Key)
```

---

## Source URLs (Working)

| Page | URL |
|------|-----|
| Home | https://docs.tempo.xyz/ |
| Full docs (LLM) | https://docs.tempo.xyz/llms-full.txt |
| Tempo Transaction Spec | https://docs.tempo.xyz/protocol/transactions/spec-tempo-transaction |
| Account Keychain Spec | https://docs.tempo.xyz/protocol/transactions/AccountKeychain |
| TIP-20 Spec | https://docs.tempo.xyz/protocol/tip20/spec |
| Fees Spec | https://docs.tempo.xyz/protocol/fees/spec-fee |
| Connection Details | https://docs.tempo.xyz/quickstart/connection-details |
| Integrate Tempo | https://docs.tempo.xyz/quickstart/integrate-tempo |
| Wallet Dev Guide | https://docs.tempo.xyz/quickstart/wallet-developers |
| Use Accounts | https://docs.tempo.xyz/guide/use-accounts |
| Embed Passkeys | https://docs.tempo.xyz/guide/use-accounts/embed-passkeys |
| WebAuthn Signatures | https://docs.tempo.xyz/guide/use-accounts/webauthn-p256-signatures |
| Building with AI | https://docs.tempo.xyz/guide/building-with-ai |
| Go SDK | https://docs.tempo.xyz/sdk/go |
| TypeScript SDKs | https://docs.tempo.xyz/sdk/typescript |
| Foundry | https://docs.tempo.xyz/sdk/foundry |
