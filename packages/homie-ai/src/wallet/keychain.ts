import type { Address, Hash, Hex } from 'viem';
import { Abis as TempoAbis, Account as TempoAccount } from 'viem/tempo';

import { TEMPO_ACCOUNT_KEYCHAIN, TEMPO_CHAIN_ID } from './runtime.js';
import type { TokenLimit } from './types.js';

export type AccessKeyType = 'Secp256k1' | 'P256' | 'WebAuthn';

export interface SignKeyAuthorizationParams {
  readonly chainId?: number | undefined;
  readonly keyId: Address;
  readonly keyType: AccessKeyType;
  readonly expiry?: number | undefined;
  readonly enforceLimits: boolean;
  readonly limits: readonly TokenLimit[];
}

export interface KeyAuthorizationPayload {
  readonly chainId: number;
  readonly keyId: Address;
  readonly keyType: AccessKeyType;
  readonly expiry: number | undefined;
  readonly enforceLimits: boolean;
  readonly limits: readonly TokenLimit[];
}

export interface KeychainContractClient {
  readContract(parameters: {
    address: Address;
    abi: readonly unknown[];
    functionName: 'getKey' | 'getRemainingLimit';
    args: readonly unknown[];
  }): Promise<unknown>;
  writeContract(parameters: {
    address: Address;
    abi: readonly unknown[];
    functionName: 'authorizeKey' | 'revokeKey' | 'updateSpendingLimit';
    args: readonly unknown[];
  }): Promise<Hash>;
}

export interface AccessKeyStatus {
  readonly authorized: boolean;
  readonly revoked: boolean;
  readonly expiry: number | undefined;
  readonly limits: readonly TokenLimit[];
}

const toSignatureType = (keyType: AccessKeyType): number => {
  if (keyType === 'Secp256k1') return 0;
  if (keyType === 'P256') return 1;
  return 2;
};

const toAccountKeyType = (keyType: AccessKeyType): 'secp256k1' | 'p256' | 'webAuthn' => {
  if (keyType === 'Secp256k1') return 'secp256k1';
  if (keyType === 'P256') return 'p256';
  return 'webAuthn';
};

export const buildKeyAuthorization = (
  params: SignKeyAuthorizationParams,
): KeyAuthorizationPayload => {
  return {
    chainId: params.chainId ?? TEMPO_CHAIN_ID,
    keyId: params.keyId,
    keyType: params.keyType,
    expiry: params.expiry,
    enforceLimits: params.enforceLimits,
    limits: params.limits,
  };
};

export const signKeyAuthorization = async (parameters: {
  rootPrivateKey: Hex;
  authorization: KeyAuthorizationPayload;
}): Promise<unknown> => {
  const rootAccount = TempoAccount.fromSecp256k1(parameters.rootPrivateKey);
  return await rootAccount.signKeyAuthorization(
    {
      accessKeyAddress: parameters.authorization.keyId,
      keyType: toAccountKeyType(parameters.authorization.keyType),
    },
    {
      ...(parameters.authorization.expiry !== undefined
        ? { expiry: parameters.authorization.expiry }
        : {}),
      ...(parameters.authorization.limits.length > 0
        ? {
            limits: parameters.authorization.limits.map((limit) => ({
              token: limit.token,
              limit: limit.amount,
            })),
          }
        : {}),
    },
  );
};

export const authorizeAccessKey = async (
  client: KeychainContractClient,
  parameters: SignKeyAuthorizationParams,
): Promise<Hash> => {
  return await client.writeContract({
    address: TEMPO_ACCOUNT_KEYCHAIN,
    abi: TempoAbis.accountKeychain,
    functionName: 'authorizeKey',
    args: [
      parameters.keyId,
      toSignatureType(parameters.keyType),
      BigInt(parameters.expiry ?? 0),
      parameters.enforceLimits,
      parameters.limits.map((limit) => ({ token: limit.token, amount: limit.amount })),
    ],
  });
};

export const revokeAccessKey = async (
  client: KeychainContractClient,
  keyId: Address,
): Promise<Hash> => {
  return await client.writeContract({
    address: TEMPO_ACCOUNT_KEYCHAIN,
    abi: TempoAbis.accountKeychain,
    functionName: 'revokeKey',
    args: [keyId],
  });
};

export const updateAccessKeySpendingLimit = async (
  client: KeychainContractClient,
  parameters: { keyId: Address; token: Address; newLimit: bigint },
): Promise<Hash> => {
  return await client.writeContract({
    address: TEMPO_ACCOUNT_KEYCHAIN,
    abi: TempoAbis.accountKeychain,
    functionName: 'updateSpendingLimit',
    args: [parameters.keyId, parameters.token, parameters.newLimit],
  });
};

export const checkAccessKeyStatus = async (
  client: KeychainContractClient,
  rootAccount: Address,
  keyId: Address,
  tokens: readonly Address[],
): Promise<AccessKeyStatus> => {
  const keyRaw = (await client.readContract({
    address: TEMPO_ACCOUNT_KEYCHAIN,
    abi: TempoAbis.accountKeychain,
    functionName: 'getKey',
    args: [rootAccount, keyId],
  })) as readonly [number, Address, bigint, boolean, boolean];

  const expiry = Number(keyRaw[2]);
  const limits = await Promise.all(
    tokens.map(async (token) => {
      const amount = (await client.readContract({
        address: TEMPO_ACCOUNT_KEYCHAIN,
        abi: TempoAbis.accountKeychain,
        functionName: 'getRemainingLimit',
        args: [rootAccount, keyId, token],
      })) as bigint;
      return { token, amount };
    }),
  );

  const revoked = Boolean(keyRaw[4]);
  const stillValid = keyRaw[2] === 0n || Number.isNaN(expiry) || expiry * 1000 > Date.now();
  return {
    authorized: !revoked && stillValid,
    revoked,
    expiry: keyRaw[2] === 0n ? undefined : Number(keyRaw[2]),
    limits,
  };
};
