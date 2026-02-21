# Viem Tempo Integration — Exhaustive Research

> Sources: viem.sh/tempo/\*, docs.tempo.xyz/\*, Tempo Transaction Spec (EIP-2718 type 0x76)
> Date: 2026-02-20

---

## 1. Overview

Tempo is a purpose-built Layer 1 blockchain optimized for payments. It enshrines
token management (TIP-20), a Fee AMM, and a stablecoin DEX directly into the
protocol. Viem provides first-class Tempo support through the `viem/tempo`
entrypoint (upstreamed from `tempo.ts` as of `viem@2.43.0`).

Key protocol-level features surfaced through viem:

- **TIP-20 tokens** — native token standard extending ERC-20 with memo support,
  transfer policies, role-based access control, and reward distribution
- **Account Keychain** — provisioned access keys with expiry + per-token
  spending limits, managed via a precompile at `0xAAAAAAAA00000000000000000000000000000000`
- **Tempo Transaction (type 0x76)** — batch calls, fee sponsorship, configurable
  fee tokens, concurrent nonces, scheduled execution, and WebAuthn/P256 signatures
- **Fee AMM** — protocol-enshrined automated market maker for fee token liquidity
- **Stablecoin DEX** — protocol-enshrined orderbook for stablecoin pairs

---

## 2. Installation & Client Setup

```typescript
import { createClient, http, publicActions, walletActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { tempoActions } from 'viem/tempo';

export const client = createClient({
  account: privateKeyToAccount('0x...'),
  chain: tempoModerato,
  transport: http(),
})
  .extend(publicActions)
  .extend(walletActions)
  .extend(tempoActions());
```

The `tempoActions()` extension decorates the client with three action namespaces
(`token.*`, `dex.*`, `amm.*`) and augments standard viem wallet actions
(`sendTransaction`, `sendTransactionSync`) with Tempo transaction properties.

---

## 3. Chain Configuration

### Available Chains

```typescript
import {
  tempoDevnet,
  tempoLocalnet,
  tempoModerato,  // Testnet (formerly tempoTestnet, renamed in viem@2.44.0)
} from 'viem/chains';
```

### tempoModerato Network Details

| Property       | Value                              |
|----------------|------------------------------------|
| Chain ID       | `42431`                            |
| RPC URL        | `https://rpc.moderato.tempo.xyz`   |
| Block Explorer | `https://explore.tempo.xyz`        |

### Default Fee Token

Set a default fee token for all transactions on a chain:

```typescript
import { tempoModerato } from 'viem/chains';

const chain = tempoModerato.extend({
  feeToken: '0x20c0000000000000000000000000000000000001',
});
```

Once set, all transactions use this token for fees unless overridden at the
transaction level.

---

## 4. Account Types (Tempo Accounts)

All Tempo accounts are backwards-compatible with viem's `Account` type. They can
be used with any viem Action that accepts an `account` parameter.

### 4.1 `Account.fromSecp256k1`

Standard Ethereum accounts from secp256k1 private keys.

```typescript
import { Account, Secp256k1 } from 'viem/tempo';

const account = Account.fromSecp256k1(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

console.log(account.address);
// 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

// Generate a random private key
const randomKey = Secp256k1.randomPrivateKey();
const randomAccount = Account.fromSecp256k1(randomKey);
```

**Parameters:**
- `privateKey: Hex` — secp256k1 private key
- `options.access?: Address | Account` — parent account for access key mode

### 4.2 `Account.fromP256`

Accounts from raw P256 private keys.

```typescript
import { Account, P256 } from 'viem/tempo';

const account = Account.fromP256('0x...');

// Random key generation
const accessKey = Account.fromP256(
  P256.randomPrivateKey(),
  { access: parentAccount }
);
```

**Parameters:**
- `privateKey: Hex` — P256 private key
- `options.access?: Address | Account` — parent account for access key mode

### 4.3 `Account.fromWebCryptoP256`

Accounts from WebCrypto P256 key pairs (useful for server-side or Node.js).

```typescript
import { Account, WebCryptoP256 } from 'viem/tempo';

const keyPair = await WebCryptoP256.createKeyPair();
const account = Account.fromWebCryptoP256(keyPair);
```

**Parameters:**
- `keyPair: { publicKey: PublicKey; privateKey: CryptoKey }` — from `WebCryptoP256.createKeyPair()`
- `options.access?: Address | Account` — parent account for access key mode

### 4.4 `Account.fromWebAuthnP256`

Accounts from WebAuthn credentials (passkeys). Enables biometric auth (Face ID,
Touch ID, fingerprint).

```typescript
import { Account, WebAuthnP256 } from 'viem/tempo';

// --- Creating a new passkey ---
const credential = await WebAuthnP256.createCredential({ name: 'Example' });
const account = Account.fromWebAuthnP256(credential);
// Store credential.publicKey in your backend for later retrieval

// --- Loading an existing passkey ---
const credential = await WebAuthnP256.getCredential({
  async getPublicKey(credential) {
    return await store.get(credential.id); // fetch from your backend
  }
});
const account = Account.fromWebAuthnP256(credential);
```

**Parameters:**
- `credential: { id: string; publicKey: Hex }` — WebAuthn credential
- `options.getFn?` — custom `navigator.credentials.get` override
- `options.rpId?: string` — relying party ID (should match your domain)

### Account Return Type (all types)

```typescript
type Account = {
  address: Address;
  keyType: string;
  publicKey: Hex;
  source: string;
  type: 'local';

  assignKeyAuthorization: (keyAuthorization: KeyAuthorization) => Promise<void>;
  sign: (parameters: { hash: Hex }) => Promise<Hex>;
  signAuthorization: (parameters: SignAuthorizationParameters) => Promise<Authorization>;
  signKeyAuthorization: (
    key: { accessKeyAddress: Address; keyType: string },
    parameters?: { expiry?: bigint; limits?: Limits }
  ) => Promise<KeyAuthorization>;
  signMessage: (parameters: { message: string | { raw: Hex } }) => Promise<Hex>;
  signTransaction: (transaction: TransactionRequest) => Promise<Hex>;
  signTypedData: (typedData: TypedData) => Promise<Hex>;
};
```

### Signature Types (Protocol Level)

| Type      | ID Byte | Description                                         |
|-----------|---------|-----------------------------------------------------|
| secp256k1 | (none)  | Standard Ethereum signatures (65 bytes)             |
| P256      | `0x01`  | Raw P256 with pub key coordinates (130 bytes)       |
| WebAuthn  | `0x02`  | WebAuthn with authenticator data (variable, max 2KB)|
| Keychain  | `0x03`  | Access key signing on behalf of root account        |

### Address Derivation

- **secp256k1**: `keccak256(uncompressed_public_key)[12:32]` (standard Ethereum)
- **P256 / WebAuthn**: `keccak256(pub_key_x || pub_key_y)[12:32]` — same key
  pair produces same address regardless of P256 vs WebAuthn signature type

---

## 5. Account Keychain & Access Keys

The Account Keychain is a protocol-enshrined precompile that manages access keys
for accounts. It enables a root key (e.g., a passkey) to provision scoped
sub-keys that can sign transactions on its behalf.

### Precompile Address

`0xAAAAAAAA00000000000000000000000000000000`

### Key Hierarchy

```
Root Key (keyId = address(0))
├── The account's primary key (address == account address)
├── No spending limits
├── Can call ALL precompile functions
└── Can authorize, revoke, and update Access Keys

Access Key (keyId != address(0))
├── Secondary keys authorized by Root Key
├── Can have expiry timestamps
├── Subject to per-TIP20 token spending limits
└── CANNOT call mutable precompile functions
```

### KeyAuthorization Protocol Structure

```rust
struct KeyAuthorization {
    chain_id: u64,                // 0 = valid on any chain
    key_type: SignatureType,      // Secp256k1 (0), P256 (1), WebAuthn (2)
    key_id: Address,              // address derived from public key
    expiry: Option<u64>,          // Unix timestamp; None = never expires
    limits: Option<Vec<TokenLimit>>, // None = unlimited spending
}

struct TokenLimit {
    token: Address,   // TIP20 token address
    limit: U256,      // Maximum spending amount
}

struct SignedKeyAuthorization {
    authorization: KeyAuthorization,
    signature: PrimitiveSignature,  // Root key's signature over keccak256(rlp(authorization))
}
```

### Creating & Using Access Keys (Full Flow in Viem)

#### Step 1: Create Root Account

```typescript
import { Account, Secp256k1 } from 'viem/tempo';

const account = Account.fromSecp256k1(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);
```

#### Step 2: Create Access Key

```typescript
const accessKey = Account.fromSecp256k1(
  Secp256k1.randomPrivateKey(),
  { access: account }  // marks this as an access key for `account`
);
```

The `{ access: account }` option works on all account types:

```typescript
// P256 access key
const p256AccessKey = Account.fromP256(
  P256.randomPrivateKey(),
  { access: account }
);

// WebCrypto P256 access key
const keyPair = await WebCryptoP256.createKeyPair();
const wcAccessKey = Account.fromWebCryptoP256(keyPair, { access: account });
```

#### Step 3: Sign Key Authorization

The root account signs a `KeyAuthorization` granting the access key permission:

```typescript
const keyAuthorization = await account.signKeyAuthorization(accessKey, {
  expiry: Math.floor(Date.now() / 1000) + 86400, // 24-hour expiry
  // limits: [{ token: '0x...', limit: 1000000000n }] // optional spending limits
});
```

`signKeyAuthorization` parameters:
- `key: { accessKeyAddress: Address; keyType: string }` — the access key
- `parameters.expiry?: bigint` — Unix timestamp for key expiration
- `parameters.limits?: Limits` — per-TIP20 token spending limits

#### Step 4: First Transaction (Authorize + Use)

Attach the `keyAuthorization` to the first transaction. The access key can sign
the same transaction in which it is being authorized:

```typescript
const receipt = await client.sendTransactionSync({
  account: accessKey,
  keyAuthorization,
  to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
});
```

#### Step 5: Subsequent Transactions (No Authorization Needed)

Once authorized on-chain, the access key can sign transactions directly:

```typescript
const receipt = await client.sendTransactionSync({
  account: accessKey,
  to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  // No keyAuthorization needed!
});
```

### Spending Limit Details

- Only applies to TIP20 direct calls: `transfer()`, `transferWithMemo()`,
  `approve()`, `startReward()`
- Native ETH value transfers are NOT limited
- `transferFrom()` is NOT limited (only when `msg.sender == tx.origin`)
- Limits deplete as tokens are spent (no time-based reset)
- Root key can update limits via `updateSpendingLimit()` without revoking

### Key Management Operations (Protocol Level)

```typescript
// Revoking a key (requires Root Key signature)
const tx = {
  calls: [{
    to: '0xAAAAAAAA00000000000000000000000000000000', // Keychain precompile
    value: 0,
    input: encodeCall('revokeKey', [keyId])
  }],
};

// Updating spending limits (requires Root Key signature)
const tx = {
  calls: [{
    to: '0xAAAAAAAA00000000000000000000000000000000',
    value: 0,
    input: encodeCall('updateSpendingLimit', [keyId, tokenAddress, newLimit])
  }],
};
```

---

## 6. Tempo Transaction Properties

All viem wallet actions are decorated with Tempo-specific properties when using
a Tempo chain:

### `calls` — Batch Transactions

Execute multiple calls atomically in a single transaction:

```typescript
const receipt = await client.sendTransactionSync({
  calls: [
    { data: '0xcafebabe...', to: '0xdead...' },
    { data: '0xdeadbeef...', to: '0xfeed...' },
    { data: '0xfeedface...', to: '0xfeed...' },
  ],
});
```

### `feePayer` — Fee Sponsorship

Let a third party pay transaction fees:

```typescript
const receipt = await client.sendTransactionSync({
  to: '0x...',
  feePayer: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  // or feePayer: true  (when using a Fee Payer Service)
});
```

Fee payer signs with magic byte `0x78` (domain-separated from sender's `0x76`).
Fee payer is always secp256k1-only.

### `feeToken` — Configurable Fee Token

Pay fees in any TIP-20 token:

```typescript
const receipt = await client.sendTransactionSync({
  to: '0x...',
  feeToken: '0x20c0000000000000000000000000000000000001',
});
```

### `nonceKey` — Concurrent Transactions

Enable parallel transaction submission:

```typescript
const receipt = await client.sendTransactionSync({
  to: '0x...',
  nonceKey: 1337n,       // unique nonce lane
  // or nonceKey: 'expiring'  // TIP-1009 expiring nonces
});
```

Nonce key `0` = protocol nonce (standard sequential). Keys `1`-`N` = independent
parallel lanes.

### `validBefore` / `validAfter` — Scheduled Execution

```typescript
const receipt = await client.sendTransactionSync({
  to: '0x...',
  validBefore: Math.floor(Date.now() / 1000) + 3600,  // must include within 1hr
  validAfter: Math.floor(Date.now() / 1000) + 60,      // can't include for 60s
});
```

### `keyAuthorization` — Access Key Authorization

See Section 5 above.

### `sendTransactionSync`

Waits for the transaction to be included in a block and returns the receipt.
Recommended for Tempo's fast block times:

```typescript
const receipt = await client.sendTransactionSync({
  account,
  to: '0x...',
  value: 1000000000000000000n,
});
```

---

## 7. Tempo Actions — Complete Reference

All Tempo actions are accessed through namespaced properties on the client.
Every write action has two variants:
- **Async** (`client.token.transfer(...)`) — returns tx hash; manually wait for receipt
- **Sync** (`client.token.transferSync(...)`) — waits for receipt automatically

The `Actions` export provides `extractEvent()` / `extractEvents()` for parsing
logs from async receipts:

```typescript
import { Actions } from 'viem/tempo';
const { args } = Actions.token.transfer.extractEvent(receipt.logs);
```

### Common Optional Parameters (all write actions)

| Parameter              | Type                | Description                                       |
|------------------------|---------------------|---------------------------------------------------|
| `account`              | `Account \| Address`| Transaction sender                                |
| `feeToken`             | `Address \| bigint` | TIP-20 fee token address or ID                    |
| `feePayer`             | `Account \| true`   | Fee payer account or `true` for Fee Payer Service  |
| `gas`                  | `bigint`            | Gas limit                                         |
| `maxFeePerGas`         | `bigint`            | Max fee per gas                                   |
| `maxPriorityFeePerGas` | `bigint`            | Max priority fee per gas                          |
| `nonce`                | `number`            | Nonce                                             |
| `nonceKey`             | `'expiring' \| bigint` | Nonce key for concurrent txs                   |
| `validBefore`          | `number`            | Unix timestamp expiration                         |
| `validAfter`           | `number`            | Unix timestamp earliest inclusion                 |
| `throwOnReceiptRevert` | `boolean`           | Throw on revert (default `true`, Sync only)       |

---

### 7.1 Token Actions (`client.token.*`)

#### `token.create` / `token.createSync`

Creates a new TIP-20 token and assigns admin role.

```typescript
const { admin, receipt, token, tokenId } = await client.token.createSync({
  admin: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  currency: 'USD',
  name: 'My Company USD',
  symbol: 'CUSD',
  // quoteToken?: Address | bigint  — optional quote token
  // salt?: Hex  — optional salt for deterministic address (default: random)
});
```

**Returns:** `{ admin, currency, name, quoteToken, receipt, symbol, token, tokenId }`

#### `token.mint` / `token.mintSync`

Mints new tokens. Requires `ISSUER` role.

```typescript
const { receipt } = await client.token.mintSync({
  amount: parseUnits('10.5', 6),
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  token: '0x20c0000000000000000000000000000000000000',
  // memo?: Hex  — optional memo
});
```

**Returns:** `{ amount, receipt, to }`

#### `token.burn` / `token.burnSync`

Burns tokens from the caller's balance.

```typescript
const { receipt } = await client.token.burnSync({
  amount: parseUnits('10.5', 6),
  token: '0x20c0000000000000000000000000000000000000',
  // memo?: Hex
});
```

**Returns:** `{ amount, from, receipt }`

#### `token.transfer` / `token.transferSync`

Transfers TIP-20 tokens.

```typescript
const { receipt } = await client.token.transferSync({
  amount: parseUnits('10.5', 6),
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  token: '0x20c0000000000000000000000000000000000000',
  // memo?: Hex  — optional memo attached to transfer event
  // from?: Address  — transfer from another address (requires approval)
});
```

**Returns:** `{ amount, from, receipt, to }`

#### `token.approve` / `token.approveSync`

Approves a spender for TIP-20 tokens.

```typescript
const { receipt } = await client.token.approveSync({
  amount: parseUnits('10.5', 6),
  spender: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  token: '0x20c0000000000000000000000000000000000000',
});
```

**Returns:** `{ owner, spender, amount, receipt }`

#### `token.getBalance`

Gets token balance (read-only).

```typescript
const balance: bigint = await client.token.getBalance({
  account: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  token: '0x20c0000000000000000000000000000000000000',
  // blockNumber?, blockTag?, stateOverride?
});
```

#### `token.getAllowance`

Gets spender allowance (read-only).

```typescript
const allowance: bigint = await client.token.getAllowance({
  account: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  spender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  token: '0x20c0000000000000000000000000000000000000',
});
```

#### `token.getMetadata`

Gets comprehensive token metadata (read-only).

```typescript
const metadata = await client.token.getMetadata({
  token: '0x20c0000000000000000000000000000000000000',
});
// metadata.name, metadata.symbol, metadata.decimals,
// metadata.currency, metadata.totalSupply,
// metadata.paused?, metadata.quoteToken?, metadata.supplyCap?,
// metadata.transferPolicyId?
```

**Returns:**
```typescript
type TokenMetadata = {
  currency: string;
  decimals: number;
  name: string;
  paused?: boolean;
  quoteToken?: Address;
  supplyCap?: bigint;
  symbol: string;
  totalSupply: bigint;
  transferPolicyId?: bigint;
};
```

#### `token.grantRoles` / `token.grantRolesSync`

Grants roles to an address. Requires admin role.

```typescript
const { receipt, value } = await client.token.grantRolesSync({
  roles: ['issuer'],
  token: '0x20c0000000000000000000000000000000000000',
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
});
```

**Role values:** `'defaultAdmin' | 'pause' | 'unpause' | 'issuer' | 'burnBlocked'`

**Returns:** `{ receipt, value: [{ role, account, sender, hasRole }] }`

#### `token.revokeRoles` / `token.revokeRolesSync`

Revokes roles from an address. Requires admin role for each role.

```typescript
const { receipt, value } = await client.token.revokeRolesSync({
  from: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  roles: ['issuer'],
  token: '0x20c0000000000000000000000000000000000000',
});
```

#### `token.renounceRoles` / `token.renounceRolesSync`

Renounces roles from the caller.

```typescript
const { receipt, value } = await client.token.renounceRolesSync({
  roles: ['issuer'],
  token: '0x20c0000000000000000000000000000000000000',
});
```

#### `token.pause` / `token.pauseSync`

Pauses a token (prevents all transfers). Requires `PAUSE` role.

```typescript
const { isPaused, receipt } = await client.token.pauseSync({
  token: '0x20c0000000000000000000000000000000000000',
});
```

**Returns:** `{ isPaused, receipt, updater }`

#### `token.changeTransferPolicy` / `token.changeTransferPolicySync`

Changes transfer policy. Requires default admin role.

```typescript
const { receipt } = await client.token.changeTransferPolicySync({
  policyId: 1n,
  token: '0x20c0000000000000000000000000000000000000',
});
```

**Returns:** `{ newPolicyId, receipt, updater }`

---

### 7.2 DEX Actions (`client.dex.*`)

Stablecoin DEX is a protocol-enshrined orderbook for trading stablecoin pairs.

#### `dex.createPair` / `dex.createPairSync`

Creates a new trading pair. Quote token is determined by base token's quote token.

```typescript
const { key, base, quote, receipt } = await client.dex.createPairSync({
  base: '0x20c0000000000000000000000000000000000001',
});
```

**Returns:** `{ key: Hex, base: Address, quote: Address, receipt }`

#### `dex.place` / `dex.placeSync`

Places a limit order on the orderbook.

```typescript
import { Tick } from 'viem/tempo';

const { orderId, receipt } = await client.dex.placeSync({
  amount: parseUnits('100', 6),
  tick: Tick.fromPrice('0.99'),
  token: '0x20c0000000000000000000000000000000000001',
  type: 'buy',  // 'buy' | 'sell'
});
```

**Returns:** `{ orderId, maker, token, amount, isBid, tick, receipt }`

**`Tick` utility:**
- `Tick.fromPrice(priceString)` — converts a decimal price string to a tick number

#### `dex.cancel` / `dex.cancelSync`

Cancels an existing order.

```typescript
const { orderId, receipt } = await client.dex.cancelSync({
  orderId: 123n,
});
```

**Returns:** `{ orderId, receipt }`

#### `dex.withdraw` / `dex.withdrawSync`

Withdraws tokens from the DEX to your wallet.

```typescript
const { receipt } = await client.dex.withdrawSync({
  amount: parseUnits('100', 6),
  token: '0x20c0000000000000000000000000000000000001',
});
```

**Returns:** `{ receipt }`

#### `dex.getBalance`

Gets user's token balance on the DEX (read-only).

```typescript
const balance: bigint = await client.dex.getBalance({
  account: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  token: '0x20c0000000000000000000000000000000000001',
});
```

---

### 7.3 AMM Actions (`client.amm.*`)

The Fee AMM is a protocol-enshrined automated market maker for token pairs.

#### `amm.mint` / `amm.mintSync`

Mints liquidity tokens by providing a token pair.

```typescript
const { liquidity, receipt } = await client.amm.mintSync({
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  userTokenAddress: '0x20c0000000000000000000000000000000000000',
  validatorTokenAddress: '0x20c0000000000000000000000000000000000001',
  validatorTokenAmount: parseUnits('100', 6),
});
```

**Returns:** `{ amountUserToken, amountValidatorToken, liquidity, receipt, sender, userToken, validatorToken }`

#### `amm.burn` / `amm.burnSync`

Burns liquidity tokens and receives underlying pair.

```typescript
const { amountUserToken, amountValidatorToken, receipt } =
  await client.amm.burnSync({
    liquidity: parseUnits('10.5', 18),
    to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
    userToken: '0x20c0000000000000000000000000000000000000',
    validatorToken: '0x20c0000000000000000000000000000000000001',
  });
```

**Returns:** `{ amountUserToken, amountValidatorToken, liquidity, receipt, sender, to, userToken, validatorToken }`

---

## 8. `viem/tempo` Exports Summary

```typescript
import {
  // Account creation
  Account,

  // Cryptographic utilities
  Secp256k1,       // Secp256k1.randomPrivateKey()
  P256,            // P256.randomPrivateKey()
  WebAuthnP256,    // WebAuthnP256.createCredential(), WebAuthnP256.getCredential()
  WebCryptoP256,   // WebCryptoP256.createKeyPair()

  // Actions extension
  tempoActions,    // Client extension function

  // Actions namespace (for extractEvent/extractEvents)
  Actions,

  // DEX utilities
  Tick,            // Tick.fromPrice('0.99')
} from 'viem/tempo';

import {
  // Chain definitions
  tempoModerato,
  tempoDevnet,
  tempoLocalnet,
} from 'viem/chains';
```

---

## 9. End-to-End Examples

### 9.1 Create Token, Mint, and Transfer

```typescript
import { createClient, http, publicActions, walletActions, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { tempoActions } from 'viem/tempo';

const client = createClient({
  account: privateKeyToAccount('0x...'),
  chain: tempoModerato,
  transport: http(),
})
  .extend(publicActions)
  .extend(walletActions)
  .extend(tempoActions());

// 1. Create token
const { token, tokenId } = await client.token.createSync({
  admin: client.account.address,
  currency: 'USD',
  name: 'Test USD',
  symbol: 'TUSD',
});

// 2. Mint tokens
await client.token.mintSync({
  amount: parseUnits('1000', 6),
  to: client.account.address,
  token,
});

// 3. Transfer tokens
await client.token.transferSync({
  amount: parseUnits('100', 6),
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  token,
});

// 4. Check balance
const balance = await client.token.getBalance({
  account: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  token,
});
console.log('Balance:', balance); // 100000000n
```

### 9.2 Access Key with Spending Limits

```typescript
import { Account, Secp256k1, tempoActions } from 'viem/tempo';

const rootAccount = Account.fromSecp256k1('0x...');

// Create a scoped access key
const accessKey = Account.fromSecp256k1(
  Secp256k1.randomPrivateKey(),
  { access: rootAccount }
);

// Sign authorization with 24h expiry (limits not yet exposed in high-level API
// but the protocol supports per-token limits)
const keyAuthorization = await rootAccount.signKeyAuthorization(accessKey, {
  expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
});

// First transaction authorizes the key AND executes the transfer
const receipt = await client.token.transferSync({
  account: accessKey,
  keyAuthorization,
  amount: parseUnits('50', 6),
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  token: '0x20c0000000000000000000000000000000000000',
});

// Subsequent transactions just work — no keyAuthorization needed
const receipt2 = await client.token.transferSync({
  account: accessKey,
  amount: parseUnits('25', 6),
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
  token: '0x20c0000000000000000000000000000000000000',
});
```

### 9.3 Passkey Account (WebAuthn)

```typescript
import { Account, WebAuthnP256 } from 'viem/tempo';

// Sign up: create passkey
const credential = await WebAuthnP256.createCredential({ name: 'My App' });
const account = Account.fromWebAuthnP256(credential);

// Store credential.id and credential.publicKey on your backend

// Sign in: load passkey
const loaded = await WebAuthnP256.getCredential({
  async getPublicKey(cred) {
    return await backend.getPublicKey(cred.id);
  }
});
const account2 = Account.fromWebAuthnP256(loaded);

// Use with any viem action
const hash = await client.sendTransactionSync({
  account: account2,
  data: '0xcafebabe',
  to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
});
```

### 9.4 Batch Calls with Fee Sponsorship

```typescript
const receipt = await client.sendTransactionSync({
  calls: [
    // Approve DEX to spend tokens
    {
      data: encodeFunctionData({ /* approve call */ }),
      to: tokenAddress,
    },
    // Place order on DEX
    {
      data: encodeFunctionData({ /* place order */ }),
      to: dexAddress,
    },
  ],
  feePayer: sponsorAddress,
  feeToken: '0x20c0000000000000000000000000000000000001',
  nonceKey: 42n,  // parallel nonce lane
});
```

### 9.5 DEX Trading

```typescript
import { Tick } from 'viem/tempo';

// Place a buy order
const { orderId } = await client.dex.placeSync({
  amount: parseUnits('1000', 6),
  tick: Tick.fromPrice('0.995'),
  token: '0x20c0000000000000000000000000000000000001',
  type: 'buy',
});

// Check DEX balance
const dexBalance = await client.dex.getBalance({
  account: client.account.address,
  token: '0x20c0000000000000000000000000000000000001',
});

// Cancel order
await client.dex.cancelSync({ orderId });

// Withdraw from DEX
await client.dex.withdrawSync({
  amount: dexBalance,
  token: '0x20c0000000000000000000000000000000000001',
});
```

---

## 10. Wagmi Integration (React)

Tempo extensions also work with Wagmi (`wagmi/tempo`) for React apps. Key
exports include:

```typescript
import { KeyManager, webAuthn } from 'wagmi/tempo';

// Wagmi config with passkey connector
const config = createConfig({
  chains: [tempoModerato],
  connectors: [webAuthn({
    keyManager: KeyManager.localStorage(), // dev only; use KeyManager.http() in prod
  })],
  transports: {
    [tempoModerato.id]: http(),
  },
});
```

React hooks: `useConnect`, `useConnectors`, `useConnection`, `useDisconnect`
from `wagmi` work seamlessly with the `webAuthn` connector for sign-up / sign-in
flows.

---

## 11. Migration Notes

- `tempo.ts/chains` & `tempo.ts/viem` upstreamed into viem as of `viem@2.43.0`
  - Use `viem/chains` instead of `tempo.ts/chains`
  - Use `viem/tempo` instead of `tempo.ts/viem`
- `tempo.ts/wagmi` upstreamed into Wagmi as of `wagmi@3.2.0`
  - Use `wagmi/tempo` or `@wagmi/core/tempo`
- `tempoTestnet` renamed to `tempoModerato` in `viem@2.44.0`

---

## 12. Key URLs

| Resource | URL |
|----------|-----|
| Viem Tempo Getting Started | https://viem.sh/tempo |
| Viem Tempo Accounts | https://viem.sh/tempo/accounts |
| Viem Tempo Chains | https://viem.sh/tempo/chains |
| Viem Tempo Actions | https://viem.sh/tempo/actions |
| Tempo Protocol Docs | https://docs.tempo.xyz |
| Tempo TypeScript SDKs | https://docs.tempo.xyz/sdk/typescript |
| Tempo Transaction Spec | https://docs.tempo.xyz/protocol/transactions/spec-tempo-transaction |
| Tempo Account Guide | https://docs.tempo.xyz/guide/use-accounts |
| Tempo Passkey Guide | https://docs.tempo.xyz/guide/use-accounts/embed-passkeys |
| Tempo Network Details | https://docs.tempo.xyz/quickstart/connection-details |
