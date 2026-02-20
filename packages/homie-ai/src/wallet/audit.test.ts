import { describe, expect, test } from 'bun:test';
import type { Address } from 'viem';

import { createWalletAuditEvent, redactWalletAuditEvent } from './audit.js';

describe('wallet/audit', () => {
  test('createWalletAuditEvent populates event and atMs', () => {
    const before = Date.now();
    const event = createWalletAuditEvent('wallet_loaded', {
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678' as Address,
    });
    expect(event.event).toBe('wallet_loaded');
    expect(event.atMs).toBeGreaterThanOrEqual(before);
    expect(event.walletAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
  });

  test('redactWalletAuditEvent truncates txHash', () => {
    const event = createWalletAuditEvent('payment_challenge', {
      txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
    });
    const redacted = redactWalletAuditEvent(event);
    expect(redacted.txHash).toMatch(/^0x[a-f0-9]+\.{3}[a-f0-9]+$/u);
    expect(redacted.txHash?.length).toBeLessThan(event.txHash?.length ?? 0);
  });

  test('redactWalletAuditEvent redacts metadata keys containing "key" or "secret"', () => {
    const event = createWalletAuditEvent('payment_failure', {
      metadata: {
        apiKey: 'supersecret123',
        secretToken: 'hidden',
        remediation: 'retry later',
      },
    });
    const redacted = redactWalletAuditEvent(event);
    const meta = redacted.metadata as
      | { apiKey?: unknown; secretToken?: unknown; remediation?: unknown }
      | undefined;
    expect(meta?.apiKey).toBe('[redacted]');
    expect(meta?.secretToken).toBe('[redacted]');
    expect(meta?.remediation).toBe('retry later');
  });

  test('redactWalletAuditEvent passes through events without sensitive fields', () => {
    const event = createWalletAuditEvent('wallet_generated', {
      reasonCode: 'first_run',
    });
    const redacted = redactWalletAuditEvent(event);
    expect(redacted.event).toBe('wallet_generated');
    expect(redacted.reasonCode).toBe('first_run');
    expect(redacted.txHash).toBeUndefined();
    expect(redacted.metadata).toBeUndefined();
  });

  test('redactWalletAuditEvent handles short txHash gracefully', () => {
    const event = createWalletAuditEvent('payment_challenge', {
      txHash: '0xshort',
    });
    const redacted = redactWalletAuditEvent(event);
    expect(redacted.txHash).toBe('[redacted]');
  });
});
