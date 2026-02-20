import { describe, expect, test } from 'bun:test';

import { generateAgentRuntimeWallet } from './runtime.js';
import { createPaymentSessionClient } from './payments.js';

describe('wallet/payments', () => {
  test('initializes with connected lifecycle and can restore', () => {
    const wallet = generateAgentRuntimeWallet();
    const client = createPaymentSessionClient({ wallet });
    expect(client.getConnectionState()).toBe('connected');
    client.restore();
    expect(client.getConnectionState()).toBe('disconnected');
  });
});
