import { type Address, createPublicClient, type Hex, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { tempoActions } from 'viem/tempo';

import type {
  AgentRuntimeWallet,
  WalletCapabilities,
  WalletNetwork,
  WalletReadinessState,
} from './types.js';

const AGENT_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/u;

export const OPENHOMIE_AGENT_KEY_ENV = 'OPENHOMIE_AGENT_KEY';
export const TEMPO_MODERATO_RPC_URL = 'https://rpc.moderato.tempo.xyz';
export const TEMPO_EXPLORER_BASE_URL = 'https://explore.tempo.xyz';
export const TEMPO_PATH_USD_TOKEN = '0x20c0000000000000000000000000000000000000' as const;
export const TEMPO_ACCOUNT_KEYCHAIN = '0xAAAAAAAA00000000000000000000000000000000' as const;
export const TEMPO_CHAIN_ID = 42431;

export interface RuntimeKeySecureStore {
  loadAgentRuntimeKey(): Promise<Hex | undefined>;
  saveAgentRuntimeKey(privateKey: Hex): Promise<void>;
}

export interface TempoPublicClient {
  readonly chain: { id: number };
  request(parameters: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  readonly token: {
    getBalance(parameters: { account: Address; token: Address }): Promise<bigint>;
  };
  readonly faucet: {
    fund(parameters: { account: Address }): Promise<readonly string[]>;
  };
}

const parseRuntimePrivateKey = (value: string | undefined): Hex | undefined => {
  const trimmed = value?.trim();
  if (!trimmed || !AGENT_KEY_PATTERN.test(trimmed)) return undefined;
  return trimmed as Hex;
};

const walletFromPrivateKey = (privateKey: Hex): AgentRuntimeWallet => {
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, privateKey };
};

export const generateAgentRuntimeWallet = (): AgentRuntimeWallet => {
  const privateKey = generatePrivateKey();
  return walletFromPrivateKey(privateKey);
};

export const isValidAgentRuntimePrivateKey = (value: string | undefined): boolean => {
  return parseRuntimePrivateKey(value) !== undefined;
};

export const deriveRuntimeWalletAddress = (privateKey: Hex): Address => {
  return privateKeyToAccount(privateKey).address;
};

export const loadAgentRuntimeWallet = async (
  env: NodeJS.ProcessEnv,
  secureStore?: RuntimeKeySecureStore,
): Promise<AgentRuntimeWallet | undefined> => {
  const envKey = parseRuntimePrivateKey(env[OPENHOMIE_AGENT_KEY_ENV]);
  if (envKey) return walletFromPrivateKey(envKey);
  if (!secureStore) return undefined;
  const stored = await secureStore.loadAgentRuntimeKey();
  return stored ? walletFromPrivateKey(stored) : undefined;
};

export const getAgentRuntimeWalletReadiness = async (
  env: NodeJS.ProcessEnv,
  secureStore?: RuntimeKeySecureStore,
): Promise<WalletReadinessState> => {
  const envRaw = env[OPENHOMIE_AGENT_KEY_ENV]?.trim();
  if (envRaw && !isValidAgentRuntimePrivateKey(envRaw)) {
    return { kind: 'invalid', reason: 'invalid_key_format' };
  }
  const wallet = await loadAgentRuntimeWallet(env, secureStore);
  if (!wallet) return { kind: 'missing' };
  return { kind: 'active', address: wallet.address, funded: false };
};

export const createTempoClient = (rpcUrl: string = TEMPO_MODERATO_RPC_URL): TempoPublicClient => {
  const client = createPublicClient({
    chain: tempoModerato,
    transport: http(rpcUrl),
  }).extend(tempoActions());
  return client as unknown as TempoPublicClient;
};

export const getAgentBalance = async (parameters: {
  address: Address;
  token?: Address | undefined;
  client?: TempoPublicClient | undefined;
}): Promise<bigint> => {
  const client = parameters.client ?? createTempoClient();
  const token = parameters.token ?? TEMPO_PATH_USD_TOKEN;
  return await client.token.getBalance({ account: parameters.address, token });
};

export const fundAgentTestnet = async (parameters: {
  address: Address;
  client?: TempoPublicClient | undefined;
}): Promise<readonly string[]> => {
  const client = parameters.client ?? createTempoClient();
  try {
    return await client.faucet.fund({ account: parameters.address });
  } catch (primaryErr) {
    try {
      const result = await client.request({
        method: 'tempo_fundAddress',
        params: [parameters.address],
      });
      if (Array.isArray(result)) return result.map((value) => String(value));
      return [String(result)];
    } catch (fallbackErr) {
      const primaryMessage = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const fallbackMessage =
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(
        `Tempo faucet funding failed via both methods. faucet.fund: ${primaryMessage}; tempo_fundAddress: ${fallbackMessage}`,
      );
    }
  }
};

export const buildAgentWalletCapabilities = (parameters: {
  readiness: WalletReadinessState;
  network?: WalletNetwork | undefined;
  hasKeychainGrant?: boolean | undefined;
  canSpend?: boolean | undefined;
}): WalletCapabilities => {
  const isActive = parameters.readiness.kind === 'active';
  return {
    canSign: isActive,
    canReceive: isActive,
    canSpend: isActive && Boolean(parameters.canSpend),
    hasKeychainGrant: isActive && Boolean(parameters.hasKeychainGrant),
    network: parameters.network ?? 'tempo-moderato',
  };
};

export const renderAgentWalletPrompt = (
  wallet: AgentRuntimeWallet | undefined,
  networkLabel: string = 'Tempo Moderato (testnet)',
): string => {
  if (!wallet) return '';
  return [
    '<agent-wallet>',
    `address: ${wallet.address}`,
    `network: ${networkLabel}`,
    'capabilities: sign, receive',
    '</agent-wallet>',
  ].join('\n');
};
