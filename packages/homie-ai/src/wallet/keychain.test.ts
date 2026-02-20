import { describe, expect, test } from 'bun:test';
import type { Address } from 'viem';

import {
  buildKeyAuthorization,
  checkAccessKeyStatus,
  type KeychainContractClient,
} from './keychain.js';

const ADDRESS_A = '0x1000000000000000000000000000000000000000' as Address;
const ADDRESS_B = '0x2000000000000000000000000000000000000000' as Address;

describe('wallet/keychain', () => {
  test('builds authorization payload with defaults', () => {
    const payload = buildKeyAuthorization({
      keyId: ADDRESS_A,
      keyType: 'Secp256k1',
      enforceLimits: true,
      limits: [{ token: ADDRESS_B, amount: 10n }],
    });
    expect(payload.chainId).toBe(42431);
    expect(payload.expiry).toBeUndefined();
    expect(payload.keyId).toBe(ADDRESS_A);
  });

  test('reads key status and remaining limits', async () => {
    const fakeClient: KeychainContractClient = {
      readContract: async ({ functionName }) => {
        if (functionName === 'getKey') return [0, ADDRESS_A, 0n, true, false] as const;
        return 5n;
      },
      writeContract: async () => '0xabc' as `0x${string}`,
    };
    const status = await checkAccessKeyStatus(fakeClient, ADDRESS_A, ADDRESS_B, [ADDRESS_B]);
    expect(status.authorized).toBe(true);
    expect(status.revoked).toBe(false);
    expect(status.limits[0]?.amount).toBe(5n);
  });
});
