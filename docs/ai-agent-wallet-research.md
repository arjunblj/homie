# AI Agent Wallet & On-Chain Identity: Comprehensive Research

> Compiled Feb 2026 from 40+ sources. Covers key generation, storage, rotation,
> HD wallets, security, signing, nonce management, gas abstraction, account
> abstraction, identity standards, and every major vendor in the space.

---

## Table of Contents

1. [The Core Problem](#1-the-core-problem)
2. [Architecture Patterns](#2-architecture-patterns)
3. [Key Generation Patterns](#3-key-generation-patterns)
4. [Key Storage Best Practices](#4-key-storage-best-practices)
5. [Key Rotation](#5-key-rotation)
6. [HD Wallets vs Standalone Keys](#6-hd-wallets-vs-standalone-keys)
7. [Security Considerations](#7-security-considerations)
8. [Signing Patterns](#8-signing-patterns)
9. [Nonce Management](#9-nonce-management)
10. [Gas Abstraction & Paymasters](#10-gas-abstraction--paymasters)
11. [Account Abstraction (ERC-4337)](#11-account-abstraction-erc-4337)
12. [On-Chain Identity Standards](#12-on-chain-identity-standards)
13. [Vendor Deep Dives](#13-vendor-deep-dives)
14. [Viem TypeScript Patterns](#14-viem-typescript-patterns)
15. [Policy & Guardrails](#15-policy--guardrails)
16. [Decision Matrix](#16-decision-matrix)

---

## 1. The Core Problem

Building an AI agent platform is fundamentally different from building a dApp. In
a typical dApp, the user initiates every transaction. With AI agents, the wallet
needs to act autonomously while still giving the owner ultimate control.

This creates a **triangle of competing needs** (Crossmint):

1. **The platform can't control the wallet** — custodial risk, legal liability, honeypot target
2. **The owner must control the wallet** — halt agent, withdraw funds, modify permissions
3. **The agent must control the wallet** — sign autonomously without human-in-the-loop

Additional critical vectors (from Crossmint, Lit Protocol, MetaMask):

| Vector | Question |
|---|---|
| **Compliance** | Is the platform non-custodial? Legal? |
| **Security** | Can keys be leaked? Is there a single point of failure? |
| **Autonomy** | Can the agent act without human intervention? |
| **Usability** | Is the DX/UX acceptable? |

The fundamental shift: modern wallet infra must move beyond "secure key storage"
to govern **how, when, and under what conditions** keys are used.

---

## 2. Architecture Patterns

### 2.1 Anti-Patterns (Avoid)

| Pattern | Problem |
|---|---|
| **Private key in env vars** | Regulatory nightmare (infra provider has control). Key leakage risk via agent prompts, logs, tool calls. Development-only. |
| **Key in config/JSON files** | Trivially exfiltrated. Sits on disk in plaintext. |
| **Shared over chat (Telegram/Discord)** | Keys persist in message history. No audit trail. |
| **Single TEE cloud (no owner backdoor)** | Agent owner can't control wallet. Single point of failure on one physical server. |
| **Managed key service (opaque)** | Still custodial ("non-custodial for end users" but custodial for the developer). Closed-source logic. Censorship risk. |

### 2.2 Recommended: Dual Key Architecture

The leading pattern uses a **smart contract wallet with two keys** (Crossmint, Openfort, Privy):

```
┌──────────────────────────────────────────────┐
│              Smart Contract Wallet            │
│          (ERC-4337 / Squads / etc.)           │
│                                               │
│   ┌─────────────┐     ┌──────────────────┐   │
│   │  Agent Key   │     │   Owner Key      │   │
│   │  (in TEE)    │     │  (user holds)    │   │
│   │              │     │                  │   │
│   │  Day-to-day  │     │  Master override │   │
│   │  autonomous  │     │  Halt / withdraw │   │
│   │  operations  │     │  Modify perms    │   │
│   └─────────────┘     └──────────────────┘   │
│                                               │
│   Policy engine enforces rules at signing     │
└──────────────────────────────────────────────┘
```

**How it works:**

- **Agent Key**: Generated inside a TEE, never leaves. Used for day-to-day signing within boundaries set by the smart contract.
- **Owner Key**: Stays with the user (embedded wallet, MetaMask, passkey, etc.). Functions as emergency brake — can halt agent, withdraw funds, rotate agent key.
- **Smart Contract Wallet**: ERC-4337 on EVM or Squads on Solana. Single wallet address with multiple authorized signers. All permissions enforced onchain.

**Benefits:**

- Non-custodial: platform never touches keys
- Keys can't be leaked: agent key never leaves TEE
- Owner maintains control: emergency override always available
- Compliant: no custodial obligations for the platform
- Cross-chain capable with smart contract extensions
- Supports transaction batching, sponsored gas, programmatic guardrails

### 2.3 Server Wallet Architecture (MetaMask ERC-8004)

MetaMask's reference architecture for production server wallets:

```
Client (Agent)  →  Backend API  →  TEE Enclave  →  Database
   │                   │               │              │
   │ agent key         │ forwards      │ verifies     │ encrypted
   │ (authenticates)   │ request       │ signs        │ key blob
   │                   │               │ enforces     │
   │                   │               │ policy       │
```

**Key operations within the TEE:**

1. **Generate account key**: Keypair created inside enclave, encrypted with agent key, blob stored in DB
2. **Sign request**: TEE validates request, enforces policy, signs, returns signature only
3. **Import/Export key**: Encrypted blob transfer, never plaintext outside enclave
4. **Rotate agent key**: Re-encrypt key blob with new agent key

**Why TEE over MPC for agent signing:** (MetaMask analysis)
- MPC TSS signing takes 4-5 seconds with 5 nodes — too slow for agents
- TEE provides single-key signing speed with policy enforcement
- MPC's decentralization benefits don't outweigh latency for server-side signing

### 2.4 Distributed Key Management (Lit Protocol)

Lit Protocol takes a different approach — **threshold MPC + TEE**:

- Keys split into encrypted fragments ("key shares")
- Each share stored in a separate sealed, encrypted VM
- Complete key never exists in its entirety in any one place
- Signing requires threshold cooperation of multiple nodes
- **Lit Actions**: Immutable JavaScript on IPFS that define what the key can do

**Agent identity methods comparison** (from Lit Protocol's analysis):

| Method | Autonomous | Human OOL | Distributed | Single PoF Risk |
|---|---|---|---|---|
| Encumbered TEE | Yes | Yes | No | **Yes** |
| Managed TEE (AWS KMS) | No (censurable) | Yes | No | Yes |
| ZKML | Yes | Yes | Yes | No |
| User Device | Conditional | Conditional | No | Yes |
| 2-of-2 MPC | No (dev controls API) | Yes | Partial | Yes |
| **Threshold MPC + TEE (Lit)** | **Yes** | **Yes** | **Yes** | **No** |

**Vincent** (Lit's successor to agent-wallet): 7,000+ agent wallets created,
programmable cross-chain wallets with policy-governed DeFi automation.

---

## 3. Key Generation Patterns

### 3.1 Raw Hexadecimal Key (Dev/Testing)

```typescript
// Using Foundry's cast
// cast wallet new
// Output: Address + Private Key

// Using viem
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
```

- Fastest setup, least secure
- Acceptable for local dev and testing
- **Never for production** without additional protection

### 3.2 HD Key Derivation (BIP-32/BIP-44)

```typescript
import { HDKey, hdKeyToAccount } from 'viem/accounts';
import { mnemonicToSeed } from '@scure/bip39';

const seed = await mnemonicToSeed(mnemonic);
const hdKey = HDKey.fromMasterSeed(seed);

// Default path: m/44'/60'/0'/0/0
const account = hdKeyToAccount(hdKey);

// Custom path for agent N
const agentAccount = hdKeyToAccount(hdKey, {
  accountIndex: agentIndex,  // m/44'/60'/${agentIndex}'/0/0
});
```

**BIP-44 structure**: `m / purpose' / coin_type' / account' / change / address_index`

- `purpose` = 44' (BIP-44)
- `coin_type` = 60' (Ethereum)
- `account` = independent identity (use for per-agent isolation)
- `change` = 0 (external) / 1 (internal)
- `address_index` = sequential addresses within account

### 3.3 AWS KMS (Production)

Recommended by Hyperlane for production agents:

- Key generated and stored in AWS CloudHSM
- Uses `ECC_SECG_P256K1` key spec (secp256k1 for Ethereum)
- IAM user with scoped permissions to sign only
- Private key material never leaves the HSM
- Requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_KMS_KEY_ID`

### 3.4 TEE-Generated Keys

Keys generated inside a Trusted Execution Environment:

- Private key material exists only in encrypted memory
- Not accessible to host OS, hypervisor, or cloud provider
- Signed attestation proves code integrity
- Used by Turnkey, Crossmint, Constella, MetaMask server wallets

### 3.5 Distributed Key Generation (DKG)

Used by Lit Protocol:

- No single party ever holds the complete key
- Key shares generated across multiple sealed VMs
- Threshold signatures require cooperation of multiple nodes
- Network of 7+ node operators (Lit v1 Naga mainnet, Dec 2025)

---

## 4. Key Storage Best Practices

### Hierarchy of security (worst to best):

| Tier | Method | Notes |
|---|---|---|
| **Never** | Hardcoded in source | Trivially compromised |
| **Never** | Config files / JSON | Plaintext on disk |
| **Dev only** | `.env` file | Acceptable locally, never in production |
| **Basic** | Encrypted at rest + env var injection | Better, but key exists in process memory |
| **Good** | Secrets manager (AWS SM, Vault, etc.) | Centralized but auditable rotation |
| **Better** | KMS / HSM | Key never leaves hardware boundary |
| **Best** | TEE enclave | Key in encrypted memory, policy enforcement, attestation |
| **Best** | Distributed MPC/TSS | Key never reconstituted, threshold signing |

### Runtime injection pattern (from API Stronghold research):

```bash
# Authenticate with API user token
api-stronghold-cli auth api-user --token $BOT_AUTH_TOKEN

# Load scoped keys into environment at runtime
eval $(api-stronghold-cli deployment env-file trading-bot-prod --stdout)

# Keys exist in process memory only, not on disk
bun run agent.ts
```

### Per-credential scoping:

Each agent should only have access to credentials it needs:

| Profile | Credentials | Risk Level |
|---|---|---|
| `agent-trader` | Trade-only API key, RPC endpoint | Medium |
| `agent-monitor` | Read-only API key, price feeds | Low |
| `agent-admin` | Withdrawal-enabled key | High (human-only) |

---

## 5. Key Rotation

### 5.1 Coinbase CDP Wallet Secret Rotation

- Navigate to CDP Portal > Server Wallet > Configuration
- Generate new secret (2FA required)
- Old secret immediately invalidated
- New secret displayed once — download and store securely
- Wallet address remains the same (only auth secret changes)

### 5.2 MetaMask TEE Agent Key Rotation

1. Generate new agent key on client side
2. Authenticate rotation request with existing agent key
3. TEE validates request and enforces policies
4. Encrypted key blob re-encrypted with new agent key
5. Stored against new public address of agent key

### 5.3 Smart Contract Wallet Signer Rotation

With smart contract wallets (ERC-4337), you can rotate signers **without changing the wallet address**:

- Add new signer to the smart wallet
- Remove old signer
- Wallet address is the contract address, not derived from any single key
- All on-chain permissions and balances preserved

### 5.4 Rotation Best Practices

- Rotate after any suspected compromise — immediately
- Rotate on regular schedule (at least monthly for active agents)
- Rotate after deployment windows / sprints
- Rotate when team members leave
- Automate rotation with CI/CD where possible
- Never have a single person who can both access and rotate production keys

---

## 6. HD Wallets vs Standalone Keys

### When to use HD Wallets (BIP-32/BIP-44):

- **Fleet management**: Single seed backs all agent wallets, one backup to secure
- **Deterministic recovery**: Same seed always produces same key hierarchy
- **Organized structure**: `accountIndex` per agent, `addressIndex` for sub-accounts
- **Cost**: No per-key generation API calls

```typescript
// Agent fleet from single seed
const seed = await mnemonicToSeed(MASTER_MNEMONIC);
const hdKey = HDKey.fromMasterSeed(seed);

function getAgentAccount(agentId: number) {
  return hdKeyToAccount(hdKey, { accountIndex: agentId });
}

const agent0 = getAgentAccount(0); // m/44'/60'/0'/0/0
const agent1 = getAgentAccount(1); // m/44'/60'/1'/0/0
const agent2 = getAgentAccount(2); // m/44'/60'/2'/0/0
```

**Risk**: Master seed is a single point of failure. If compromised, all agent wallets are compromised.

### When to use Standalone Keys:

- **Isolation**: Compromise of one key doesn't affect others
- **Independent lifecycle**: Each key can be rotated/revoked independently
- **TEE generation**: Keys generated inside secure enclaves can't use shared seeds
- **Managed services**: Coinbase, Privy, Turnkey generate independent keys per wallet

### When to use Smart Contract Wallets (recommended for production):

- **Multiple signers**: Agent key + owner key on same address
- **Permission scoping**: Onchain rules about what each signer can do
- **Signer rotation**: Change keys without changing address
- **Batching**: Multiple calls in one transaction
- **Gas abstraction**: Paymaster sponsorship built-in

### Recommendation for agent platforms:

| Scenario | Approach |
|---|---|
| Dev/testing | HD wallet from test mnemonic |
| Single self-hosted agent | Standalone key in KMS/TEE |
| Agent platform/launchpad | Smart contract wallet (ERC-4337) with dual keys |
| Fleet of autonomous agents | Smart contract wallets, each with TEE-generated agent key |
| User-owned agents | Smart wallet owned by user, agent added as scoped signer |

---

## 7. Security Considerations

### 7.1 Agent-Specific Threats

| Threat | Description | Mitigation |
|---|---|---|
| **Prompt injection → key exfil** | Malicious input tricks agent into revealing private key | Never expose key to agent logic. TEE isolation. |
| **Hallucination spending** | Agent hallucinates valid-looking but unintended transaction | Spending limits, allowlists, simulation checks |
| **Tool call exfiltration** | Agent tools accidentally log or transmit key material | Keys only in TEE/KMS, never in agent context |
| **Developer backdoor** | Agent developer has access to key material | Non-custodial architecture, distributed keys |
| **Platform honeypot** | Centralized platform holding many agent keys | Smart contract wallets, no platform custody |
| **Replay attacks** | Re-submitting previously signed transactions | Nonce management, EIP-712 domain separator |
| **Nonce manipulation** | Stuck or skipped nonces block agent operations | Off-chain nonce tracking, multi-account parallelism |

### 7.2 Defense in Depth

**Layer 1: Key isolation**
- Private keys never exist in agent process memory
- All signing happens in TEE/KMS/MPC
- Agent receives signatures, never key material

**Layer 2: Policy enforcement**
- Per-transaction spending limits
- Daily/weekly aggregate limits
- Contract/address allowlists
- Method/function allowlists
- Time-based controls (business hours only, etc.)
- Chain restrictions

**Layer 3: Monitoring & detection**
- Real-time transaction monitoring
- Anomaly detection
- Tamper-evident audit trails
- Alert on policy violations
- Webhook notifications for all transactions

**Layer 4: Human override**
- Owner key as emergency brake
- Multi-sig for high-value operations
- Human approval required above thresholds
- Kill switch to freeze agent wallet

### 7.3 Credential Isolation Checklist

From the API Stronghold crypto agent security research:

- [ ] Never store private keys in config files — inject at runtime
- [ ] Never give a bot withdrawal permissions unless absolutely required
- [ ] Use trade-only API keys for automated trading
- [ ] Scope credentials per bot — each bot gets only what it needs
- [ ] Rotate exchange keys regularly (at least monthly)
- [ ] Use a dedicated wallet for each bot with limited funds
- [ ] Enable IP whitelisting on exchange API keys where supported
- [ ] Audit access regularly
- [ ] Use zero-knowledge encryption so secrets manager can't read your keys
- [ ] Never share keys over Telegram, Discord, or Slack

---

## 8. Signing Patterns

### 8.1 Direct EOA Signing (Simple)

```typescript
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const account = privateKeyToAccount('0x...');
const client = createWalletClient({
  account,
  chain: base,
  transport: http(),
});

// Sign and send transaction
const hash = await client.sendTransaction({
  to: '0x...',
  value: parseEther('0.01'),
});

// Sign message (for auth, attestation, etc.)
const signature = await client.signMessage({
  message: 'Agent attestation',
});

// Sign typed data (EIP-712)
const typedSig = await client.signTypedData({
  domain: { name: 'AgentProtocol', version: '1', chainId: 8453 },
  types: { Action: [{ name: 'intent', type: 'string' }] },
  primaryType: 'Action',
  message: { intent: 'swap 100 USDC for ETH' },
});
```

### 8.2 Smart Account Signing (ERC-4337)

```typescript
import { createPublicClient, createBundlerClient, http, parseEther } from 'viem';
import { toCoinbaseSmartAccount } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const client = createPublicClient({ chain: base, transport: http() });
const owner = privateKeyToAccount('0x...');

const account = await toCoinbaseSmartAccount({
  client,
  owners: [owner],
  version: '1.1',
});

const bundlerClient = createBundlerClient({
  account,
  client,
  transport: http('https://public.pimlico.io/v2/8453/rpc'),
});

// Send UserOperation (batched calls)
const hash = await bundlerClient.sendUserOperation({
  calls: [
    { to: '0xTokenAddr', data: approveCalldata },
    { to: '0xSwapRouter', data: swapCalldata },
  ],
});

const receipt = await bundlerClient.waitForUserOperationReceipt({ hash });
```

### 8.3 Coinbase AgentKit Signing

```typescript
import { AgentKit, CdpV2WalletProvider } from '@coinbase/agentkit';

const walletProvider = await CdpV2WalletProvider.configureWithWallet({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
  networkId: 'base',
});

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [], // add GOAT SDK, custom actions, etc.
});

// AgentKit handles signing internally via CDP server wallet
```

### 8.4 Privy Server Wallet Signing

```typescript
import { PrivyWalletProvider } from '@coinbase/agentkit';

const walletProvider = await PrivyWalletProvider.configureWithWallet({
  appId: process.env.PRIVY_APP_ID,
  appSecret: process.env.PRIVY_APP_SECRET,
  walletId: process.env.PRIVY_WALLET_ID,
  authorizationPrivateKey: process.env.PRIVY_AUTH_KEY,
  authorizationKeyId: process.env.PRIVY_AUTH_KEY_ID,
});
// Also plugs into AgentKit as a wallet provider
```

---

## 9. Nonce Management

### The Problem

EVM nonces are sequential counters per account. Transactions must process in
strict order (0, 1, 2...). For agents sending concurrent transactions, this
creates bottlenecks and failure modes:

- **Nonce gaps**: Skipped nonces block all subsequent transactions
- **Duplicate nonces**: Multiple txs with same nonce compete; only one succeeds
- **Stuck transactions**: Failed/dropped tx blocks all higher nonces indefinitely

### Best Practices for Agents

**1. Off-chain nonce store**
```typescript
// Maintain local nonce state per account
const nonceMap = new Map<string, number>();

async function getNextNonce(address: string, client: PublicClient): Promise<number> {
  if (!nonceMap.has(address)) {
    const onchainNonce = await client.getTransactionCount({ address });
    nonceMap.set(address, onchainNonce);
  }
  const nonce = nonceMap.get(address)!;
  nonceMap.set(address, nonce + 1);
  return nonce;
}
```

**2. Multi-account parallelism**

Distribute independent transactions across multiple EOAs:
```
Agent has 10 derived accounts:
  Account 0: handles swaps
  Account 1: handles transfers
  Account 2: handles approvals
  ...
```

Each account manages its own nonce independently. Eliminates contention.

**3. Account Abstraction (eliminates the problem)**

Smart accounts (ERC-4337) handle nonce management in the smart contract:
- Custom nonce schemes per smart account
- Bundlers handle UserOperation ordering
- No nonce gaps from the agent's perspective
- Batched calls in single UserOperation

**4. Error handling and recovery**
- Detect stuck transactions (no confirmation after timeout)
- Replace with same nonce + higher gas ("speed up")
- Re-sync local nonce from chain on failures
- Implement exponential backoff for retries

---

## 10. Gas Abstraction & Paymasters

### ERC-4337 Paymasters

Paymasters are smart contracts that sponsor gas fees for UserOperations:

```typescript
import { createPaymasterClient } from 'viem/account-abstraction';

const paymasterClient = createPaymasterClient({
  transport: http('https://public.pimlico.io/v2/8453/rpc'),
});

const bundlerClient = createBundlerClient({
  account,
  client,
  paymaster: paymasterClient, // gas sponsored
  transport: http('https://public.pimlico.io/v2/8453/rpc'),
});
```

**How it works:**
1. Agent creates UserOperation without gas payment
2. Bundler forwards to Paymaster's `validatePaymasterUserOp()`
3. Paymaster decides whether to sponsor (based on policies)
4. If approved, Paymaster covers gas from its EntryPoint deposit
5. `postOp()` handles accounting (charge ERC-20 token, log, etc.)

**Sponsorship policy options:**
- Max spend limits (per-sender, per-operation, global)
- Transaction count limits
- Sender allowlists/blocklists
- Time windows
- Method/contract restrictions

**Major Paymaster providers:**
- Pimlico
- Alchemy
- ZeroDev
- Biconomy
- Candide
- Circle (USDC-based)

### Why this matters for agents:

Agents need gas to operate. Without paymasters, you need to:
1. Fund every agent wallet with ETH
2. Monitor balances across all agent wallets
3. Top up when low

With paymasters:
1. Single deposit covers gas for all agent operations
2. Policy controls which operations get sponsored
3. Agents can operate on chains where they hold zero native token
4. Pay gas in stablecoins (USDC, etc.)

---

## 11. Account Abstraction (ERC-4337)

### Core Components

| Component | Role |
|---|---|
| **Smart Account** | On-chain wallet contract with custom validation logic |
| **UserOperation** | Meta-transaction object (sender, nonce, callData, signature) |
| **EntryPoint** | Singleton contract that validates and executes UserOperations |
| **Bundler** | Off-chain node that packages UserOps into on-chain transactions |
| **Paymaster** | Optional contract that sponsors gas fees |

### Why ERC-4337 is ideal for agents:

1. **Multiple signers**: Agent key + owner key on same wallet
2. **Programmable validation**: Custom logic for which transactions are allowed
3. **Transaction batching**: Multiple calls in single UserOp (approve + swap)
4. **Gas abstraction**: Paymaster sponsorship, ERC-20 gas payment
5. **Nonce abstraction**: Custom nonce schemes, no sequential bottleneck
6. **Key rotation**: Change signers without changing address
7. **Recovery**: Social recovery, time-locked recovery, multisig recovery

### Session Keys (ZeroDev)

Session keys enable scoped, time-limited signing authority:

- Define custom permissions (allowed contracts, methods, value limits)
- Grant to agent's backend for autonomous operation
- Revocable at any time by the wallet owner
- Great for delegating limited authority to AI agents

ZeroDev describes session keys as **"the JWTs of web3"** — temporary, scoped
authorization tokens for smart accounts.

### Smart Account Implementations

| Implementation | Standard | Notable For |
|---|---|---|
| **Coinbase Smart Wallet** | ERC-4337 | Native viem support (`toCoinbaseSmartAccount`) |
| **ZeroDev Kernel** | ERC-4337 + EIP-7702 | Session keys, 6M+ accounts deployed |
| **Biconomy** | ERC-4337 | Session keys, multi-chain |
| **Safe (Gnosis)** | Multisig + ERC-4337 modules | Battle-tested, modular |
| **Alchemy Modular Account** | ERC-6900 | Modular plugins |
| **Crossmint** | ERC-4337 | Dual-key agent architecture |
| **Openfort** | ERC-4337 | Agent-specific, sub-50ms signing |

---

## 12. On-Chain Identity Standards

### 12.1 ERC-8004: Trustless Agents

**Authors**: Marco De Rossi (MetaMask), Davide Crapis (EF), Jordan Ellis (Google), Erik Reppel (Coinbase)
**Created**: August 13, 2025 — Draft status

Three lightweight on-chain registries:

**Identity Registry** (ERC-721 based):
- Each agent gets an NFT-based identity
- Globally unique ID: `{namespace}:{chainId}:{registryAddress}`
- Registration file (JSON) resolves from tokenURI
- Supports A2A, MCP, ENS, DID, and email endpoints
- `agentWallet` field with EIP-712/ERC-1271 verified wallet

**Reputation Registry**:
- Standard interface for posting/fetching feedback
- On-chain scoring for composability
- Off-chain aggregation for sophisticated algorithms

**Validation Registry**:
- Hooks for recording independent validator checks
- Stake-secured re-execution
- zkML proofs
- TEE oracles

**Trust models are pluggable and tiered**:
- Low-stake (ordering pizza): reputation only
- Medium-stake (DeFi operations): reputation + validation
- High-stake (medical/financial): all layers + human approval

### 12.2 Decentralized Identifiers (DIDs) + Verifiable Credentials

From the arXiv paper (2511.02841, Oct 2025):

- Agents get W3C DIDs anchored on-chain
- Self-sovereign digital identity
- Exchange VCs (Verifiable Credentials) to establish trust
- Cross-domain verifiable without pre-existing relationship
- Limitation: LLMs can't reliably control security procedures alone

### 12.3 SIGIL Protocol (Solana)

- Cryptographic identity through key ownership proof
- Visual fingerprints ("Glyphs") for agent identification
- Tamper-evident receipt chains
- On-chain anchors to prevent impersonation

### 12.4 SelfClaw

- Sybil-resistant identity using Self.xyz zero-knowledge proofs
- Links agents to real humans without storing personal data
- Verified agents create self-custody EVM wallets
- Can deploy their own ERC-20 tokens autonomously

---

## 13. Vendor Deep Dives

### 13.1 Coinbase AgentKit

**What**: Toolkit for AI agents to interact with blockchain. Framework-agnostic (works with LangChain, Vercel AI SDK, Eliza, etc.)

**Wallet providers** (plug-and-play):
- `CdpV2WalletProvider` (recommended) — EVM + Solana, TEE-backed
- `CdpWalletProvider` — legacy, CDP Server Wallet
- `ViemWalletProvider` — any EVM chain via viem
- `PrivyWalletProvider` — Privy server wallets
- `SolanaKeypairWalletProvider` — Solana native

**Key config** (TypeScript):
```typescript
const walletProvider = await CdpV2WalletProvider.configureWithWallet({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
  networkId: 'base',
});
```

**Two-layer auth**: Secret API Key for general requests, Wallet Secret for signing operations.

**Wallet secret rotation**: Via CDP Portal, 2FA required, old secret immediately invalidated.

**Default actions**: `get_balance`, `transfer`, `get_wallet_details`. Extensible via action providers.

### 13.2 Privy

**Two models for agent wallets:**

**Model 1: Agent-controlled, developer-owned**
- Backend controls wallet via authorization keys
- Fully autonomous — no user approval needed
- Agent executes within policy constraints

**Model 2: User-owned with agent signers**
- User retains ownership and ultimate control
- Agent added as additional signer with scoped policies
- User can revoke agent access at any time

**Policy controls:**
- Transfer limits (per-tx, per-time-window)
- Allowlisted contracts
- Recipient restrictions
- Action-specific rules
- Time-based controls

**Authorization keys:**
- Created in Privy Dashboard
- Private keys stored securely by developer
- Key quorums for multi-party approval of critical actions
- Keys never embedded in agent prompts or logic

### 13.3 Turnkey

**Infrastructure**: TEE-based key management

**Key features:**
- 50-100ms signing latency (50-100x faster than MPC)
- Policy engine for transaction rules
- Delegated access controls
- Multi-chain support (arbitrary signing)
- 99.9% uptime

**Notable deployments:**
- 200,000+ machine-initiated transactions per day
- Spectral Labs: AI agents executing smart contracts
- Azura: DeFi trading terminal
- Moonshot: mobile crypto trading
- Alchemy: Wallets-as-a-Service backend

**Production pattern**: 1:2 multisig contract wallets — both AI agent and user can broadcast from single wallet.

### 13.4 Crossmint

**Architecture**: Smart contract wallets with on-chain permission enforcement

**Agent Wallet API**:
```typescript
const agentWallet = await fetch('https://crossmint.com/api/v1-alpha2/wallets', {
  method: 'POST',
  body: JSON.stringify({
    type: 'evm-smart-wallet',
    config: {
      signer: {
        type: 'evm-keypair',
        address: process.env.AGENT_PUBLIC_KEY,
      },
    },
  }),
});
```

**Differentiators:**
- Permissions enforced onchain (not via TEEs or off-chain middleware)
- No vendor lock-in — update admin signer without changing address
- GOAT SDK integration (250+ onchain actions across 40+ chains)
- World Store API (1B+ SKUs for agent commerce)
- MiCA authorized (EU regulatory compliance)

### 13.5 Lit Protocol / Vincent

**Architecture**: Threshold MPC + TEE (defense-in-depth)

**How it works:**
- Programmable Key Pairs (PKPs) — ECDSA keypairs as ERC-721 NFTs
- Private keys never exposed, signing via distributed Lit network
- Lit Actions: immutable JavaScript on IPFS/blockchain
- Policy enforcement through on-chain registry of tools and policies

**Vincent** (successor): Non-custodial, policy-governed wallets
- User controls policies through on-chain registry
- Developer cannot access or steal funds
- Cross-chain execution with uniform security
- 7,000+ wallets created, live on Lit v1 (Naga) mainnet

### 13.6 NEAR AI

**Architecture**: TEE-based (Intel TDX + NVIDIA Confidential Computing)

**Agent Market**: Decentralized marketplace where agents:
- Bid on tasks
- Execute work autonomously
- Receive payment in NEAR tokens
- Compete to complete tasks

**OpenClaw**: Personal AI agent with NEAR wallet integration + Privy wallet support.

### 13.7 Constella

**Purpose**: Non-custodial wallet for AI agent autonomy

- Each wallet operates within TEE
- No human (including developer, owner, Constella team) can access wallet contents
- Security verified through cryptographic proofs
- Designed to prove agent is truly autonomous (not human-controlled)

### 13.8 Openfort

**Focus**: Agent wallet infra for autonomous finance

- Sub-50ms signing
- 25+ EVM chains
- W3C verifiable credentials for agent identity
- Transaction cost 40% lower than other AA wallets
- Integrates with LangChain, CrewAI, AutoGen
- Real-time monitoring, anomaly detection
- Gas sponsorship built-in

### 13.9 Alchemy (Smart Wallets for AI Agents)

**Case study**: Virtuals Protocol
- 17,000+ agents with $8B+ LTV
- Smart wallets for each autonomous agent
- Agent Commerce Protocol (ACP) for agent-to-agent transactions
- ~20K autonomous transactions processed
- Autonomous Hedge Fund Group + Autonomous Media House clusters

### 13.10 ZeroDev

**Kernel**: Minimal, extensible smart account
- ERC-4337 + EIP-7702 support
- 6M+ smart accounts across 50+ networks
- Session keys for AI agent automation
- Gas abstraction (ERC-20 payment, sponsorship)
- Transaction batching
- Chain abstraction

---

## 14. Viem TypeScript Patterns

### 14.1 Project Setup

```typescript
// tsconfig.json: strict mode required for full type safety
// TypeScript v5.0.4+ required
// Lock viem to specific patch release (types update in patches)
```

### 14.2 Account Types

```typescript
// EOA from private key
import { privateKeyToAccount } from 'viem/accounts';
const account = privateKeyToAccount('0x...');

// HD wallet
import { HDKey, hdKeyToAccount } from 'viem/accounts';
const hdKey = HDKey.fromMasterSeed(seed);
const account = hdKeyToAccount(hdKey, { accountIndex: 0 });

// Smart account (ERC-4337)
import { toCoinbaseSmartAccount } from 'viem/account-abstraction';
const smartAccount = await toCoinbaseSmartAccount({
  client,
  owners: [account],
  version: '1.1',
});
```

### 14.3 Client Architecture

```typescript
import { createPublicClient, createWalletClient, http } from 'viem';
import { createBundlerClient, createPaymasterClient } from 'viem/account-abstraction';
import { base } from 'viem/chains';

// Public client (read-only, no wallet needed)
const publicClient = createPublicClient({
  chain: base,
  transport: http(),
});

// Wallet client (EOA signing)
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(),
});

// Bundler client (smart account UserOperations)
const bundlerClient = createBundlerClient({
  account: smartAccount,
  client: publicClient,
  transport: http(BUNDLER_RPC),
  paymaster: createPaymasterClient({ transport: http(PAYMASTER_RPC) }),
});
```

### 14.4 Bundle Size Optimization

```typescript
// Instead of pre-decorated clients, import actions directly
import { sendTransaction } from 'viem/actions';
const hash = await sendTransaction(walletClient, { to: '0x...', value: 1n });
```

### 14.5 ABI Type Safety

```typescript
// Use const assertions for full type inference
const abi = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const; // <-- critical for type safety
```

---

## 15. Policy & Guardrails

### 15.1 TEE Policy Types (from MetaMask reference)

| Policy | Description |
|---|---|
| **Spend limits** | Max value per transaction and per day |
| **Scope limits** | Allowlisted contracts, methods, tokens |
| **Chain limits** | Allow only supported networks |
| **Frequency limits** | Throttle transaction bursts |
| **Simulation checks** | Sign only if dry-run looks safe |
| **Human approval** | Require second click for unusual activity |

### 15.2 Smart Contract Policy Enforcement (Crossmint)

All permissions enforced onchain, not via opaque middleware:
- Delegated signers with scoped permissions
- Onchain programmable logic
- Fully auditable transaction records
- Built-in MFA/recovery flows

### 15.3 Privy Policy Language

```
Policy constraints for agents:
- Transfer limits: max per-tx, max per time window
- Allowlisted contracts: restrict to approved protocols
- Recipient restrictions: limit where funds can go
- Action-specific rules: control swap/trade parameters
- Time-based controls: when agents can operate
```

### 15.4 Non-Custodial Spending Controls Pattern

From agent-spending-controls (open source):
- Per-transaction limits
- Daily aggregate limits
- Real-time monitoring
- Tamper detection
- Audit trail
- Works with any wallet SDK (demonstrated with Tether WDK)

---

## 16. Decision Matrix

### Choosing Your Architecture

| Factor | EOA + TEE | Smart Wallet (4337) | Managed Service | Distributed MPC |
|---|---|---|---|---|
| **Setup complexity** | Low | Medium | Low | High |
| **Signing speed** | ~10ms | ~100ms (via bundler) | ~50ms | ~4-5s |
| **Multi-signer** | No | Yes | Varies | Threshold |
| **Key rotation** | New address | Same address | Same address | Complex |
| **Gas abstraction** | No | Paymaster | Varies | No |
| **Tx batching** | No | Yes | Varies | No |
| **Owner override** | No (unless multisig) | Yes | Varies | Threshold |
| **Vendor lock-in** | None | Low (standard) | High | Medium |
| **Regulatory clarity** | You hold keys | Non-custodial | Varies | Varies |
| **Best for** | Simple bots | Production agents | Quick start | Max decentralization |

### Recommended Stack for Production Agents

```
┌────────────────────────────────────────────┐
│           Recommended Production Stack      │
├────────────────────────────────────────────┤
│                                            │
│  Smart Contract Wallet (ERC-4337)          │
│    ├── Owner Key: User-held (passkey/EOA)  │
│    └── Agent Key: TEE-generated            │
│                                            │
│  Signing: Turnkey or Coinbase CDP TEE      │
│  Bundler: Pimlico or Alchemy              │
│  Paymaster: Pimlico or ZeroDev            │
│  SDK: viem + @coinbase/agentkit           │
│  Identity: ERC-8004 (when finalized)      │
│  Policy: On-chain via smart wallet modules │
│                                            │
│  Alternative managed options:              │
│    Privy (server wallets + policies)       │
│    Crossmint (agent wallet API)            │
│    Openfort (agent-specific infra)         │
│                                            │
└────────────────────────────────────────────┘
```

### Minimal Viable Agent Wallet (for starting out)

```typescript
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

// 1. Generate key (store in env, never in code)
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

// 2. Create wallet client
const wallet = createWalletClient({
  account,
  chain: base,
  transport: http(),
});

// 3. Sign transactions
const hash = await wallet.sendTransaction({
  to: recipientAddress,
  value: parseEther('0.01'),
});
```

Upgrade path:
1. Start with EOA + env var (dev)
2. Move key to KMS/secrets manager (staging)
3. Upgrade to smart wallet with TEE signer (production)
4. Add paymaster for gas abstraction
5. Add ERC-8004 identity when standard finalizes

---

## Sources

- Crossmint: AI Agent Wallet Architecture (blog.crossmint.com)
- Crossmint: Embedded Agent Wallets (blog.crossmint.com)
- Crossmint: Wallets Architecture (docs.crossmint.com)
- MetaMask: Design Server Wallets with ERC-8004 (docs.metamask.io)
- Lit Protocol: Key Management & Identity for Crypto Agents (spark.litprotocol.com)
- Lit Protocol: Introducing the Lit Agent Wallet (spark.litprotocol.com)
- Coinbase: AgentKit Wallet Management (docs.cdp.coinbase.com)
- Coinbase: Wallet Secret Rotation (docs.cloud.coinbase.com)
- Privy: Agentic Wallets (docs.privy.io)
- Privy: Server-Side Access to User Wallets (docs.privy.io)
- Turnkey: AI Agents Solution (turnkey.com)
- Turnkey: Spectral Labs Case Study (turnkey.com)
- NEAR AI: Agent Market (near.ai)
- Constella: AI Agent Wallet (docs.constella.one)
- Openfort: Agent Wallet Infrastructure (openfort.io)
- Alchemy: Virtuals AI Agent Smart Wallets Case Study (alchemy.com)
- ZeroDev: Session Keys & Permissions (docs.zerodev.app)
- Distilled AI: AI Agent Wallets (docs.agents.land)
- ERC-8004: Trustless Agents (eips.ethereum.org)
- ERC-8004 Best Practices (best-practices.8004scan.io)
- ERC-4337: Account Abstraction (docs.erc4337.io, eips.ethereum.org)
- Hyperlane: Agent Keys (docs.hyperlane.xyz)
- Viem: hdKeyToAccount, privateKeyToAccount, Account Abstraction (viem.sh)
- BIP-44: Multi-Account HD Wallets (bips.dev)
- Kaia: Secure Wallet Management Cookbook (docs.kaia.io)
- API Stronghold: Securing Crypto AI Agents (apistronghold.com)
- arXiv 2511.02841: AI Agents with DIDs and VCs
- GOAT SDK: Agentic Finance Toolkit (ohmygoat.dev)
- SelfClaw: Trust Layer for AI Agent Economies (selfclaw.ai)
- SIGIL Protocol: Identity Infrastructure for AI Agents (sigilprotocol.xyz)
