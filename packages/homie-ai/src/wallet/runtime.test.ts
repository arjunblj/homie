import { describe, expect, test } from 'bun:test';

import {
  buildAgentWalletCapabilities,
  deriveRuntimeWalletAddress,
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
});
