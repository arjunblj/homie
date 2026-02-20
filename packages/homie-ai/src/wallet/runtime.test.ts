import { describe, expect, test } from 'bun:test';

import {
  buildAgentWalletCapabilities,
  deriveRuntimeWalletAddress,
  fundAgentTestnet,
  generateAgentRuntimeWallet,
  HOMIE_AGENT_KEY_ENV,
  isValidAgentRuntimePrivateKey,
  loadAgentRuntimeWallet,
} from './runtime.js';

describe('wallet/runtime', () => {
  test('generates a valid runtime wallet', () => {
    const wallet = generateAgentRuntimeWallet();
    expect(wallet.privateKey.startsWith('0x')).toBe(true);
    expect(wallet.privateKey.length).toBe(66);
    expect(isValidAgentRuntimePrivateKey(wallet.privateKey)).toBe(true);
    expect(deriveRuntimeWalletAddress(wallet.privateKey)).toBe(wallet.address);
  });

  test('loads runtime wallet from env key', async () => {
    const wallet = generateAgentRuntimeWallet();
    const loaded = await loadAgentRuntimeWallet({
      [HOMIE_AGENT_KEY_ENV]: wallet.privateKey,
    });
    expect(loaded?.address).toBe(wallet.address);
  });

  test('returns undefined for invalid env key', async () => {
    const loaded = await loadAgentRuntimeWallet({
      [HOMIE_AGENT_KEY_ENV]: '0x1234',
    });
    expect(loaded).toBeUndefined();
  });

  test('builds capabilities from readiness', () => {
    const wallet = generateAgentRuntimeWallet();
    const caps = buildAgentWalletCapabilities({
      readiness: { kind: 'active', address: wallet.address, funded: true },
      hasKeychainGrant: true,
      canSpend: true,
    });
    expect(caps.canSign).toBe(true);
    expect(caps.canSpend).toBe(true);
    expect(caps.hasKeychainGrant).toBe(true);
  });

  test('fundAgentTestnet falls back to tempo_fundAddress when faucet.fund fails', async () => {
    const wallet = generateAgentRuntimeWallet();
    const client = {
      chain: { id: 42431 },
      request: async () => ['0xabc'],
      token: {
        getBalance: async () => 0n,
      },
      faucet: {
        fund: async () => {
          throw new Error('faucet unavailable');
        },
      },
    };

    const txs = await fundAgentTestnet({
      address: wallet.address,
      client,
    });
    expect(txs).toEqual(['0xabc']);
  });

  test('fundAgentTestnet includes both errors when fallback also fails', async () => {
    const wallet = generateAgentRuntimeWallet();
    const client = {
      chain: { id: 42431 },
      request: async () => {
        throw new Error('rpc failed');
      },
      token: {
        getBalance: async () => 0n,
      },
      faucet: {
        fund: async () => {
          throw new Error('faucet unavailable');
        },
      },
    };

    await expect(
      fundAgentTestnet({
        address: wallet.address,
        client,
      }),
    ).rejects.toThrow('faucet.fund: faucet unavailable; tempo_fundAddress: rpc failed');
  });
});
