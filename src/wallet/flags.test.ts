import { describe, expect, test } from 'bun:test';

import { assertWalletFeatureCompatibility, loadWalletFeatureFlags } from './flags.js';

describe('wallet/flags', () => {
  test('parses wallet feature flags with expected defaults', () => {
    const flags = loadWalletFeatureFlags({});
    expect(flags).toEqual({
      identityEnabled: true,
      governanceEnabled: false,
      autonomousSpendEnabled: false,
    });
  });

  test('throws when autonomous spend flag is enabled', () => {
    const flags = loadWalletFeatureFlags({ OPENHOMIE_WALLET_AUTONOMOUS_SPEND_ENABLED: 'true' });
    expect(() => assertWalletFeatureCompatibility(flags)).toThrow(
      'OPENHOMIE_WALLET_AUTONOMOUS_SPEND_ENABLED is not supported yet',
    );
  });
});
