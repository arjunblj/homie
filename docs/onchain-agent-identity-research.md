# On-Chain Identity Patterns for AI Agents

Comprehensive research on how AI agents prove identity, sign messages, and participate in economic protocols. Compiled Feb 2026.

---

## Table of Contents

1. [Identity Verification Patterns](#1-identity-verification-patterns)
2. [Relevant EIPs & Standards](#2-relevant-eips--standards)
3. [Attestation Schemes](#3-attestation-schemes)
4. [Message Signing Standards](#4-message-signing-standards)
5. [Payment Receipt Patterns](#5-payment-receipt-patterns)
6. [Agent-to-Agent Protocols](#6-agent-to-agent-protocols)
7. [Existing Frameworks & Toolkits](#7-existing-frameworks--toolkits)
8. [Academic Research](#8-academic-research)
9. [Key Primitives Summary](#9-key-primitives-summary)

---

## 1. Identity Verification Patterns

### 1.1 ERC-721 Identity Registry (ERC-8004)

The most mature on-chain agent identity pattern. Each agent is minted as an ERC-721 token with a `tokenURI` pointing to a registration file.

**How it works:**
- Agent owner calls `register(agentURI)` to mint an NFT representing the agent
- The `agentURI` resolves to a JSON registration file (on IPFS, HTTPS, or base64 on-chain)
- Registration file describes endpoints (A2A, MCP, DID, ENS), capabilities, supported trust models, wallet addresses
- The agent is globally identified by `{namespace}:{chainId}:{identityRegistry}:{agentId}` (e.g., `eip155:1:0x742...:22`)

**Agent wallet binding:**
- The `agentWallet` metadata key stores the agent's payment address
- Setting a new wallet requires an EIP-712 signature (EOA) or ERC-1271 verification (smart contract wallet) — cryptographic proof of control
- On NFT transfer, `agentWallet` is automatically cleared and must be re-verified by the new owner

**Registration file structure:**
```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "myAgentName",
  "description": "Natural language description of the agent",
  "services": [
    { "name": "A2A", "endpoint": "https://agent.example/.well-known/agent-card.json", "version": "0.3.0" },
    { "name": "MCP", "endpoint": "https://mcp.agent.eth/", "version": "2025-06-18" },
    { "name": "DID", "endpoint": "did:method:foobar", "version": "v1" },
    { "name": "ENS", "endpoint": "vitalik.eth", "version": "v1" }
  ],
  "x402Support": true,
  "supportedTrust": ["reputation", "crypto-economic", "tee-attestation"],
  "registrations": [{ "agentId": 22, "agentRegistry": "eip155:1:0x742..." }]
}
```

**Endpoint domain verification (optional):**
Agents can prove control of an HTTPS endpoint by publishing `https://{domain}/.well-known/agent-registration.json` containing matching `registrations` entry.

**Authors:** Marco De Rossi (MetaMask), Davide Crapis (Ethereum Foundation), Jordan Ellis (Google), Erik Reppel (Coinbase).

### 1.2 Multi-Layer Verification Registry (ERC-8126)

A complementary standard focused on *security assessment* rather than discovery. Agents self-register with EIP-712 signed credentials and undergo four verification types:

| Verification | What it checks |
|---|---|
| **ETV** (Ethereum Token Verification) | Smart contract presence, known vulnerability patterns |
| **SCV** (Staking Contract Verification) | Staking mechanism security, reentrancy, flash loan attacks |
| **WAV** (Web Application Verification) | HTTPS endpoint security, SSL, OWASP Top 10 |
| **WV** (Wallet Verification) | Transaction history, threat database status |

**Risk scoring:** Unified 0–100 scale. Scores calculated as average of applicable verification types:
- 0–20: Low Risk
- 21–40: Moderate
- 41–60: Elevated
- 61–80: High Risk
- 81–100: Critical

**Privacy architecture:** All verification results processed through Private Data Verification (PDV) to generate Zero-Knowledge Proofs. Detailed results accessible only to agent wallet holders.

**Payment for verification:** Uses x402 micropayments via EIP-3009 (gasless USDC transfers).

**Requires:** EIP-155 (replay protection), EIP-712 (typed signing), EIP-3009 (gasless transfers), ERC-191 (signed data).

### 1.3 Cryptographic Fingerprinting (AgentID)

A simpler pattern: hash the agent's configuration, anchor it on-chain.

**How it works:**
1. SHA-256 hash of agent config (system prompt, tools, constraints) → identity hash
2. Hash anchored on Base Mainnet via identity contract (`0x471C4c43...`)
3. Public, immutable proof — verifiable even if AgentID disappears

**Trust score composition:**
- 30% Keypair signature
- 50% Wallet verification
- 20% Chain anchoring

**CLI interface:**
```bash
npx agentidbase fingerprint        # Generate identity hash
npx agentidbase anchor <hash>      # Anchor on-chain
npx agentidbase verify <hash>      # Verify
npx agentidbase twitter @handle    # Link Twitter
```

**Verification without trusting AgentID:**
```bash
cast call 0x471C4c43672be2d49A2ceC79203c23b7194A22Fa \
  "verifyIdentity(bytes32)" 0xYOUR_HASH \
  --rpc-url https://mainnet.base.org
```

### 1.4 W3C DIDs + Verifiable Credentials

Agents receive self-sovereign digital identities using W3C standards:

**DID (Decentralized Identifier):**
- Unique, cryptographically verifiable identifier
- Resolves to a DID document containing public keys, service endpoints, authentication methods
- Anchored in distributed ledger (e.g., Hyperledger Indy) for tamper-proof key material
- Agent controls private keys → can prove ownership without any central authority
- Supports key rotation without involving certificate authorities

**Verifiable Credentials (VCs):**
- Issued by third parties (e.g., organization's orchestrator agent)
- Encode claims: identity attributes, roles, capabilities, authorizations, delegations
- Cryptographically signed by issuer's DID → tamper-resistant, verifiable across domains
- Stored locally by agent, shared on-demand as Verifiable Presentations (VPs)

**Authentication flow (from TU Berlin prototype):**
1. Agent A presents its DID + VCs as a Verifiable Presentation to Agent B
2. Agent B verifies VP signature against ledger-anchored public key
3. Agent B checks issuer trustworthiness
4. Mutual authentication when both parties verify each other's VPs

**Delegation chains:** VCs can encode human→agent and agent→agent delegation, creating auditable chains of authority.

### 1.5 Vouch Protocol

Cryptographic identity for AI agents built on Ed25519 signatures and DIDs.

**Key features:**
- Ed25519 signatures bind every action to a verifiable DID
- Chain of custody: delegation chains for multi-agent systems, track full lineage of any action
- Git workflow integration: signs all commits with `Vouch-DID: did:vouch:9f85a3...`
- Cloud KMS support: AWS KMS, Google Cloud KMS, Azure Key Vault (keys never leave HSM)
- Framework integrations: LangChain, CrewAI, AutoGPT, MCP

**Install:** `pip install vouch-protocol`

---

## 2. Relevant EIPs & Standards

### ERC-8004: Trustless Agents (Draft)
- **Status:** Draft, Standards Track: ERC
- **Created:** 2025-08-13
- **Authors:** MetaMask, Ethereum Foundation, Google, Coinbase
- **Requires:** EIP-155, EIP-712, EIP-721, EIP-1271
- **Purpose:** Three registries (Identity, Reputation, Validation) for agent discovery and trust across organizational boundaries
- **Key insight:** Payments are orthogonal — handled by x402 separately

### ERC-8126: AI Agent Registration and Verification (Draft)
- **Status:** Draft, Standards Track: ERC
- **Created:** 2025-01-15
- **Requires:** EIP-155, EIP-191, EIP-712, EIP-3009
- **Purpose:** Self-registration with four verification types, ZK proofs, unified risk scoring

### EIP-712: Typed Structured Data Hashing and Signing
- **Role in agent identity:** The foundation for human-readable signing in agent registration
- Used by ERC-8004 for wallet ownership proof (`setAgentWallet` requires EIP-712 signature)
- Used by ERC-8126 for agent registration signing
- Prevents blind-signing attacks by displaying structured data
- Includes domain separation to prevent cross-chain replay

### EIP-3009: Transfer With Authorization
- **Role in agent payments:** Enables gasless USDC transfers — the payment mechanism behind x402
- Agent signs an off-chain authorization: "I authorize transfer of X USDC from my wallet to Y"
- Relayer/facilitator submits on-chain and pays gas
- Non-sequential nonces allow parallel transactions
- Single atomic call (no approve + transferFrom two-step)
- **Used by:** x402, ERC-8126 verification payments, AP2 settlement

### ERC-1271: Standard Signature Validation for Smart Contract Wallets
- Used by ERC-8004 to validate wallet ownership for smart contract wallets (vs EIP-712 for EOAs)
- Enables agent wallets to be smart contracts with programmable authorization logic

### EIP-155: Simple Replay Attack Protection
- Chain ID inclusion in signatures prevents cross-chain replay of agent registrations

### ERC-191: Signed Data Standard
- Standardized prefix for signed messages in wallet verification
- Ensures compatibility across wallets, prevents signature malleability

### ERC-721: Non-Fungible Token Standard
- Foundation of ERC-8004's Identity Registry — each agent is an NFT
- Enables transferability, browsability with existing NFT tooling

---

## 3. Attestation Schemes

### 3.1 Ethereum Attestation Service (EAS)

Open-source, permissionless infrastructure for on-chain and off-chain attestations.

**Scale:** 8.7M+ attestations, 450k+ unique attesters, 2.2M+ recipients.

**Architecture:** Two smart contracts:
1. Schema Registry — register attestation schemas
2. Attestation Contract — make attestations

**Agent use cases:**
- Agent verification and swarm membership
- Publishing receipts and tracking task completion
- Documenting contributions in multi-agent workflows
- Attesting AI model provenance and reasoning logs
- Triggering payments after attestations
- Fact-checking and content verification

**Integration path:**
- EAS SDK (npm) + Coinbase AgentKit
- Agents hold wallets and make attestations directly
- Base Mainnet: EAS natively integrated with predeploy contract addresses
- Supports making, revoking, delegating, and batching attestations

### 3.2 ERC-8004 Validation Registry

A generic hooks system for requesting and recording independent validation checks.

**Validation request flow:**
1. Agent posts `validationRequest(validatorAddress, agentId, requestURI, requestHash)` on-chain
2. `requestURI` → off-chain data with all inputs/outputs needed for verification
3. `requestHash` = keccak256 commitment to that data
4. Validator calls `validationResponse(requestHash, response, responseURI, responseHash, tag)`
5. `response` = 0–100 (binary: 0=failed, 100=passed; or spectrum)
6. Multiple responses allowed per request (progressive validation: "soft finality" → "hard finality")

**Supported validation mechanisms:**
- Stake-secured re-execution (crypto-economic)
- zkML verifiers (zero-knowledge machine learning proofs)
- TEE oracles (Trusted Execution Environment attestations, e.g., Oasis ROFL)
- Trusted judges (human or automated)

### 3.3 TEE Attestations (Oasis ROFL)

Agents execute inside a Trusted Execution Environment. ROFL produces attestations proving code C ran on inputs I and produced outputs O.

**Flow:**
1. Deploy agent to ROFL enclave (reproducible build, pinned artifacts)
2. Execute agent inside TEE
3. ROFL returns attestation: `{codeDigest, inputHash, outputHash, enclaveID}`
4. Attestation posted to ERC-8004 Validation Registry
5. Off-chain verifier checks attestation signature + chain, optionally re-executes

### 3.4 Zero-Knowledge Proofs

Used by ERC-8126's PDV (Private Data Verification):
- Verification occurs, results processed into ZK proofs
- Third parties can validate verification happened without seeing raw data
- Supports Groth16, PLONK (note: vulnerable to quantum — QCV layer available for post-quantum encryption)

### 3.5 Verifiable Execution Traces (VET)

Framework for authenticating agent outputs independent of host infrastructure:
- **Agent Identity Document (AID):** Specifies agent's configuration and required proof systems
- Supports multiple mechanisms: trusted hardware, cryptographic proofs, notarized TLS transcripts
- Host-independent verification

---

## 4. Message Signing Standards

### 4.1 EIP-712 Typed Data Signing

The primary standard for agent message signing on Ethereum.

**Structure:**
```
EIP712Domain {
  string name;
  string version;
  uint256 chainId;
  address verifyingContract;
}
```

**Agent uses:**
- Signing agent registration transactions (ERC-8126)
- Proving wallet ownership when setting `agentWallet` (ERC-8004)
- Signing payment authorizations (x402 via EIP-3009)
- Domain separation prevents replay across chains and contracts

**Implementation tools:**
- `eip-712` npm package — full TypeScript support for signing and verifying
- `eip712-codegen` — generates Solidity code for recovering signatures
- Brane SDK — Java/Kotlin type-safe APIs

### 4.2 EIP-3009 Transfer Signatures

Gasless token transfer authorization:

```
TransferWithAuthorization {
  address from;
  address to;
  uint256 value;
  uint256 validAfter;
  uint256 validBefore;
  bytes32 nonce;
}
```

Signed off-chain by agent → submitted by facilitator on-chain → agent pays zero gas.

### 4.3 Ed25519 Signatures (Vouch Protocol / W3C VCs)

Used in DID-based identity systems:
- Verifiable Credentials signed with Ed25519 (JSON-LD format, URDNA2015 normalization)
- Verifiable Presentations include holder proof (signature over VP)
- Cloud KMS integration (AWS/GCP/Azure) — keys never leave HSM

### 4.4 AP2 Verifiable Digital Credentials (VDCs)

Cryptographic mandates signed by relevant parties:
- **Cart Mandate:** User's cryptographic signature on exact items + price → non-repudiable proof of intent
- **Intent Mandate:** Defines constraints under which agent can act autonomously
- **Payment Mandate:** Signals agent involvement to acquirers for risk assessment

---

## 5. Payment Receipt Patterns

### 5.1 x402: HTTP-Native Micropayments

**The dominant agent payment standard.** Built by Coinbase, uses HTTP 402 "Payment Required."

**Flow:**
1. Agent sends standard HTTP request to service
2. Server returns `402 Payment Required` with payment details:
   ```json
   {
     "x402Version": 1,
     "accepts": [{
       "scheme": "exact",
       "network": "base",
       "maxAmountRequired": "25000",
       "payTo": "0x742d35Cc...",
       "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
       "maxTimeoutSeconds": 300
     }]
   }
   ```
3. Agent signs EIP-3009 payment authorization (gasless, ~200ms)
4. Agent retries with `X-PAYMENT` header containing signed authorization
5. Facilitator verifies signature, checks balance, executes on-chain transfer
6. Server delivers service, returns receipt with `txHash`

**Economics:**
- Base network fees: ~$0.0016 per transaction
- Enables payments down to $0.001
- Compare: credit card minimum $0.30 + 2.9% per transaction

**x402 V2 additions (Dec 2025):**
- Wallet-based identity and reusable access sessions (avoid repeated on-chain interactions)
- Automatic service discovery
- Support for subscriptions, prepaid access, usage-based billing
- Multi-chain, multi-asset unified payment interface

**Chains supported:** Base, Ethereum, Solana, BNB, Algorand.

### 5.2 AP2: Agent Payments Protocol

Google Cloud + Coinbase protocol (Sep 2025). 60+ launch partners.

**Settlement architecture:**
- On-chain: identity anchoring, mandate anchoring, settlement, event logging
- Off-chain: LLM negotiation, UX, multi-agent orchestration

**Receipt pattern:**
- Every transaction produces cryptographic receipts + verifiable event logs
- Receipts can be fed into ERP systems
- Regulators can request auditable histories
- Agents score counterparties based on settlement behavior

**Mandates as verifiable credentials:**
- Payment Mandate → signals AI involvement to payment networks
- Cart Mandate → user's explicit cryptographic authorization for specific purchase
- Intent Mandate → defines agent's autonomous purchasing authority

### 5.3 ERC-8004 Proof of Payment

The Reputation Registry's off-chain feedback file supports a `proofOfPayment` field:
```json
{
  "proofOfPayment": {
    "fromAddress": "0x00...",
    "toAddress": "0x00...",
    "chainId": "1",
    "txHash": "0x00..."
  }
}
```
Links reputation feedback directly to settlement proof, enabling payment-weighted reputation.

### 5.4 L402: Lightning HTTP 402

Bitcoin Lightning Network variant of HTTP 402:
- Combines Macaroons (authentication tokens) with Lightning payments
- Near-instant Bitcoin payments with extremely low fees
- Lightning Labs open-sourced agent tools (Feb 2026): run Lightning nodes, manage wallets, pay for L402-gated APIs

### 5.5 d402: DecentraLab Protocol

Variant supporting any ERC-20 token on any chain:
- Public service index for agent discovery
- No intermediaries — direct on-chain settlement
- Positioned as "MCP & API Monetization Layer"

### 5.6 Superfluid: Streaming Payments

Continuous per-second token flows — alternative to discrete transactions:
- Sender's balance decreases and receiver's balance increases every second
- No locked capital; inflows/outflows netted in real-time
- Ideal for compute, data, and service subscriptions
- $1.4B+ streamed to 1.18M+ recipients
- Smart contract interface: `createFlow(token, receiver, flowRate)`

---

## 6. Agent-to-Agent Protocols

### 6.1 A2A (Agent2Agent) by Google

Foundation messaging layer for multi-agent systems:
- Agent authentication via AgentCards
- Skills advertisement and capability discovery
- Direct messaging and task-lifecycle orchestration
- Transport for AP2 payment negotiation

### 6.2 AP2 (Agent Payments Protocol)

Commerce layer on top of A2A:
- Agents publish services with pricing, SLAs, dispute policies
- Buyer agents negotiate terms via structured A2A messages
- Settlement via x402 stablecoin rail
- MCP tools treated as billable surfaces — usage metered via AP2

**Relationship:**
- MCP gives agents tools
- A2A gives them shared language
- AP2 gives them ability to charge for work

### 6.3 BlockA2A

Security-focused extension of A2A:
- DIDs for cryptographically verifiable agent identities
- Blockchain-anchored metadata hashes (full payloads off-chain)
- Defense Orchestration Engine: Byzantine agent flagging, execution halting, permission revocation
- Sub-second overhead
- Context-aware smart contract access control

### 6.4 ANP (Agent Network Protocol)

Uses DIDs anchored in centrally managed web servers (more pragmatic, less decentralized).

### 6.5 NANDA Index

"DNS for AI agents" — decentralized discovery architecture:
- Minimal index: agent IDs, credential pointers, AgentFacts URLs (~120 bytes per record)
- AgentFacts: JSON-LD documents with capabilities, endpoints, telemetry, credentials
- Sub-second global propagation via CRDT-based updates
- Privacy-preserving discovery with least-disclosure queries
- Originated at MIT

### 6.6 XMTP + Base App

Decentralized messaging protocol for agent chat:
- Agents get wallets + Basenames (e.g., `myagent.base.eth`)
- x402 payments embedded in message flows
- Quick Actions and Intent content types for structured agent interactions

---

## 7. Existing Frameworks & Toolkits

### 7.1 Coinbase AgentKit + Agentic Wallets (Feb 2026)

First wallet infrastructure purpose-built for AI agents:

**Built-in skills:** Authenticate, Fund, Send, Trade, Earn

**Wallet management:**
- One-to-one: each agent has an EOA with locally stored keys
- CDP Server Wallet v2: up to 20 addresses per wallet
- Production: keys encrypted in databases, stored in TEEs

**Framework support:** LangChain, Eliza, Vercel AI SDK — framework-agnostic

**x402 at core:** agents can autonomously:
- Pay for compute and API access
- Monitor DeFi positions
- Participate in creator economies
- Gasless USDC/EURC/cbBTC on Base

### 7.2 Pepay

"Payment layer for autonomous agents" — self-custody wallets:
- Modular design: swap chains, add features, fork
- Autonomous invoicing: time-bound, partial payments, fraud-proof tracking
- Multi-chain: BNB, SOL, ETH, BASE
- AI keeps its own keys, no middlemen

### 7.3 nullpath

Agent marketplace with integrated payments:
- Register agent ($0.10 USDC)
- Define capabilities and pricing
- Discovery via API
- x402 payment verification, settlement, and escrow handled

### 7.4 Attest Protocol

Portable, verifiable credentials for agent identity:
- Selective disclosure
- ZK verification
- 500+ integrated applications

### 7.5 Stripe ACP (Agentic Commerce Protocol)

For regulated e-commerce (complementary to x402):
- Shared Payment Tokens (SPTs): scoped payment authorizations
- Human-in-the-loop for high-value transactions
- Fraud detection, disputes, refunds, compliance
- x402 can be integrated as settlement rail within ACP

### 7.6 P402

Facilitator network for x402:
- Executes gasless USDC payments on Base L2
- Sub-50ms verification times
- Acts as relayer for EIP-3009 authorizations

---

## 8. Academic Research

### 8.1 "AI Agents with DIDs and VCs" (TU Berlin, Oct 2025)
**arXiv:2511.02841**

Prototype: two security domains, each with two LLM agents (LangChain + AutoGen), mutual authentication via A2A protocol with DID/VC exchange.

**Key findings:**
- Technical feasibility demonstrated, but LLM sole orchestration of security procedures is unreliable
- GPT-4.1 best performer but still imperfect completion rates
- LLMs sometimes altered VC fields (broke integrity), forgot data, or agreed to skip authentication against policy
- Recommendation: migrate VC/VP routing to deterministic component, let LLM handle trust decisions and unstructured claim interpretation

### 8.2 "Agent Exchange: Shaping the Future of AI Agent Economics" (Jul 2025)
**arXiv:2507.03904**

Proposes AEX — auction platform for agent coordination inspired by real-time bidding:
- Four traits of agent-centric economy: economic autonomy, protocol-based coordination, trustless interactions, permissionless participation
- Components: User-Side Platforms, Agent-Side Platforms, Agent Hubs, Data Management Platforms

### 8.3 BlockA2A (Aug 2025)
**arXiv:2508.01332**

Adds blockchain-anchored trust to A2A:
- DID documents with capabilities and policy constraints
- Selective on-chain anchoring (hashes only, payloads off-chain)
- Defense Orchestration Engine for real-time attack mitigation
- Sub-second overhead in production

### 8.4 VET: Verifiable Execution Traces (Dec 2025)
**arXiv:2512.15892**

Host-independent agent output verification:
- Agent Identity Document (AID) specifies configuration and proof requirements
- Supports trusted hardware, cryptographic proofs, notarized TLS transcripts

### 8.5 ETHOS Framework (Dec 2024)
**arXiv:2412.17114**

Decentralized governance for AI agents:
- Global AI Agent Registry using SSI
- Soulbound Tokens for digital identity verification
- DAO-based governance with weighted expertise
- Smart contract compliance enforcement
- ZK proofs for transparent-but-private verification

### 8.6 LOKA Protocol

Ethically governed agent ecosystems:
- Universal Agent Identity Layer using DIDs and VCs
- Interoperable, verifiable identities across frameworks

### 8.7 NANDA Index (MIT, Jul 2025)
**arXiv:2507.14263**

"Beyond DNS" for AI agents:
- Lean index (~120 bytes per agent)
- AgentFacts: JSON-LD documents with cryptographic verification
- Five guarantees: interoperability, rapid resolution, sub-second revocation, schema-validated capabilities, privacy-preserving discovery

---

## 9. Key Primitives Summary

### Identity Layer

| Primitive | Type | Chain | Key Feature |
|---|---|---|---|
| ERC-8004 Identity Registry | ERC-721 NFT | Any EVM L2 | Agent-as-NFT with off-chain registration file |
| ERC-8126 Registration | Smart contract | Ethereum | Four-type verification + ZK proofs |
| AgentID | SHA-256 hash | Base | Config fingerprint anchored on-chain |
| W3C DIDs | Decentralized ID | Any ledger | Self-sovereign, ledger-anchored key material |
| Vouch Protocol | Ed25519/DID | Off-chain | Git-integrated, Cloud KMS, delegation chains |
| NANDA AgentFacts | JSON-LD | Distributed | Schema-validated capability assertions |

### Signing & Auth

| Primitive | Purpose | Gas? |
|---|---|---|
| EIP-712 | Typed structured data signing for registration, wallet proof | No (off-chain signing) |
| EIP-3009 | Gasless USDC transfer authorization | No (relayer pays) |
| ERC-1271 | Smart contract wallet signature validation | On-chain verification |
| ERC-191 | Standard signed data format | No (off-chain) |
| Ed25519 + VCs | VC/VP signing for DID-based auth | No (off-chain) |

### Payment Rails

| Protocol | Settlement | Minimum Tx | Speed | Model |
|---|---|---|---|---|
| x402 | Base, Solana, ETH | ~$0.001 | ~200ms | HTTP 402 + EIP-3009 |
| AP2 | x402 + cards + bank | fractions of cent | ~200ms (crypto) | Mandates + A2A |
| L402 | Lightning Network | sub-cent | instant | Macaroons + Lightning |
| d402 | Any EVM chain | varies | ~200ms | Any ERC-20 |
| Superfluid | Any EVM chain | continuous | per-block | Streaming flows |

### Trust & Attestation

| Mechanism | Verification Type | On-chain? |
|---|---|---|
| EAS | Schema-based attestations | On-chain or off-chain |
| ERC-8004 Reputation | Client feedback (value + tags) | Compact on-chain, full off-chain |
| ERC-8004 Validation | Validator responses (0–100) | On-chain |
| TEE (Oasis ROFL) | Code execution attestation | Off-chain proof, on-chain anchor |
| zkML | ML model verification | On-chain verifier |
| ZK Proofs (PDV) | Privacy-preserving verification | On-chain proof |
| Soulbound Tokens | Non-transferable identity | On-chain |

### Agent Discovery

| System | Resolution | Scale |
|---|---|---|
| ERC-8004 Identity Registry | On-chain events + subgraphs | Per-chain singleton |
| A2A AgentCards | `.well-known/agent-card.json` | HTTP-based |
| NANDA Index | CRDT-based global propagation | Billions of agents |
| nullpath | REST API | Marketplace |
| ENS / Basenames | `agent.base.eth` | DNS-like |

---

## Key Architectural Patterns

### Pattern 1: Register → Attest → Transact
1. Agent mints ERC-721 identity (ERC-8004)
2. Undergoes verification (ERC-8126) or TEE attestation (ROFL)
3. Reputation accumulates through client feedback
4. Transacts via x402/AP2 with cryptographic receipts linking back to identity

### Pattern 2: DID → VC Exchange → Collaborate
1. Agent receives DID anchored in distributed ledger
2. Obtains VCs from trusted issuers (capabilities, authorizations)
3. At dialogue start, exchanges VPs with peer agent for mutual authentication
4. Collaboration proceeds with verified trust

### Pattern 3: Wallet → Sign → Pay → Receipt
1. Agent holds private key (EOA or smart contract wallet via ERC-1271)
2. Service returns HTTP 402 with payment requirements
3. Agent signs EIP-3009 authorization (gasless)
4. Facilitator executes on-chain, returns txHash receipt
5. Receipt optionally posted to ERC-8004 Reputation Registry as proof of payment

### Pattern 4: Streaming Economy
1. Agent registers on Superfluid
2. Opens continuous payment stream to service provider
3. Pays per-second for compute, data, or API access
4. Stream auto-adjusts or cancels based on agent logic

---

## Open Questions & Risks

1. **LLM reliability in security procedures:** TU Berlin evaluation showed LLMs sometimes skip authentication, alter VCs, or forget data during security flows. Deterministic routing of security-critical operations is recommended.

2. **Sybil resistance:** On-chain identity alone doesn't prevent fake agents. Mitigations: stake requirements, reviewer reputation systems, economic costs for registration.

3. **MEV / front-running:** Agent registration with valuable names/URIs vulnerable to front-running. Mitigations: commit-reveal schemes, name reservation windows.

4. **Quantum threats:** Current EIP-712/ECDSA signatures vulnerable to future quantum computers. ERC-8126 includes optional QCV (Quantum Cryptography Verification) layer.

5. **Agent wallet security:** A bug or exploit could cause an agent to drain its wallet at machine speed. Mitigations: spending limits, whitelisted addresses, time-based caps, automatic shutdown on anomalous behavior.

6. **Cross-chain identity fragmentation:** Agent registered on Chain A may operate on Chain B. ERC-8004 allows multi-chain registration but cross-chain identity is still evolving.

7. **Regulatory ambiguity:** Who is liable when an autonomous agent makes a fraudulent transaction? AP2 addresses this with Payment Mandates that signal AI involvement, but legal frameworks are still catching up.
