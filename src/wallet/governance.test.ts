import { describe, expect, test } from 'bun:test';

import {
  buildGrantSummary,
  buildRotateRuntimeSummary,
  createMacOsGuidance,
  createOperatorRootAuthority,
  type GovernanceApprovalRequest,
  runGovernanceApproval,
} from './governance.js';
import { generateAgentRuntimeWallet } from './runtime.js';

describe('wallet/governance', () => {
  test('createOperatorRootAuthority returns undefined when no passkey ID', () => {
    expect(createOperatorRootAuthority({})).toBeUndefined();
  });

  test('createOperatorRootAuthority returns passkey authority when set', () => {
    const authority = createOperatorRootAuthority({
      OPENHOMIE_OPERATOR_PASSKEY_ID: 'cred-abc',
    });
    expect(authority?.kind).toBe('passkey');
    expect(authority?.credentialId).toBe('cred-abc');
  });

  test('createOperatorRootAuthority trims whitespace', () => {
    const authority = createOperatorRootAuthority({
      OPENHOMIE_OPERATOR_PASSKEY_ID: '  cred-trimmed  ',
    });
    expect(authority?.credentialId).toBe('cred-trimmed');
  });

  test('createOperatorRootAuthority returns undefined for whitespace-only value', () => {
    expect(createOperatorRootAuthority({ OPENHOMIE_OPERATOR_PASSKEY_ID: '   ' })).toBeUndefined();
  });

  test('runGovernanceApproval returns timeout when no callback and open succeeds', async () => {
    const request: GovernanceApprovalRequest = {
      action: 'grant',
      summary: 'test grant',
      callbackUrl: 'https://invalid.test/cb',
    };
    const result = await runGovernanceApproval(request, {
      openUrl: async () => true,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  test('runGovernanceApproval returns launch_failed when open fails', async () => {
    const request: GovernanceApprovalRequest = {
      action: 'grant',
      summary: 'test grant',
      callbackUrl: 'https://invalid.test/cb',
    };
    const result = await runGovernanceApproval(request, {
      openUrl: async () => false,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('launch_failed');
  });

  test('runGovernanceApproval returns approved when callback confirms', async () => {
    const request: GovernanceApprovalRequest = {
      action: 'grant',
      summary: 'test grant',
      callbackUrl: 'https://invalid.test/cb',
    };
    const result = await runGovernanceApproval(request, {
      openUrl: async () => true,
      awaitCallback: async () => true,
    });
    expect(result).toEqual({ approved: true, reason: 'approved' });
  });

  test('runGovernanceApproval returns cancelled when callback denies', async () => {
    const request: GovernanceApprovalRequest = {
      action: 'grant',
      summary: 'test grant',
      callbackUrl: 'https://invalid.test/cb',
    };
    const result = await runGovernanceApproval(request, {
      openUrl: async () => true,
      awaitCallback: async () => false,
    });
    expect(result).toEqual({ approved: false, reason: 'cancelled' });
  });

  test('runGovernanceApproval returns launch_failed when callback throws', async () => {
    const request: GovernanceApprovalRequest = {
      action: 'grant',
      summary: 'test grant',
      callbackUrl: 'https://invalid.test/cb',
    };
    const result = await runGovernanceApproval(request, {
      openUrl: async () => true,
      awaitCallback: async () => {
        throw new Error('callback transport failed');
      },
    });
    expect(result).toEqual({ approved: false, reason: 'launch_failed' });
  });

  test('buildRotateRuntimeSummary includes both addresses', () => {
    const old = generateAgentRuntimeWallet();
    const next = generateAgentRuntimeWallet();
    const summary = buildRotateRuntimeSummary(old, next);
    expect(summary).toContain(old.address);
    expect(summary).toContain(next.address);
    expect(summary).toContain('Rotate');
  });

  test('buildGrantSummary includes runtime address', () => {
    const wallet = generateAgentRuntimeWallet();
    const summary = buildGrantSummary({ runtimeAddress: wallet.address });
    expect(summary).toContain(wallet.address);
    expect(summary).toContain('Grant');
  });

  test('buildGrantSummary includes operator address when provided', () => {
    const wallet = generateAgentRuntimeWallet();
    const operator = generateAgentRuntimeWallet();
    const summary = buildGrantSummary({
      runtimeAddress: wallet.address,
      operatorAddress: operator.address,
    });
    expect(summary).toContain(operator.address);
  });

  test('createMacOsGuidance returns non-empty guidance for grant', () => {
    const guidance = createMacOsGuidance({
      action: 'grant',
      summary: 'test',
      callbackUrl: 'https://example.com/cb',
    });
    expect(guidance.length).toBeGreaterThan(0);
    expect(guidance.some((line) => line.includes('grant'))).toBe(true);
    expect(guidance.some((line) => line.includes('https://example.com/cb'))).toBe(true);
  });

  test('rejects javascript: callback URLs', async () => {
    const request: GovernanceApprovalRequest = {
      action: 'grant',
      summary: 'test xss',
      callbackUrl: 'javascript:alert(1)',
    };
    const result = await runGovernanceApproval(request);
    expect(result.approved).toBe(false);
  });

  test('rejects file: callback URLs', async () => {
    const request: GovernanceApprovalRequest = {
      action: 'grant',
      summary: 'test file access',
      callbackUrl: 'file:///etc/passwd',
    };
    const result = await runGovernanceApproval(request);
    expect(result.approved).toBe(false);
  });

  test('rejects data: callback URLs', async () => {
    const request: GovernanceApprovalRequest = {
      action: 'grant',
      summary: 'test data uri',
      callbackUrl: 'data:text/html,<script>alert(1)</script>',
    };
    const result = await runGovernanceApproval(request);
    expect(result.approved).toBe(false);
  });

  test('rejects http callback URLs', async () => {
    const request: GovernanceApprovalRequest = {
      action: 'grant',
      summary: 'test insecure callback',
      callbackUrl: 'http://example.com/cb',
    };
    const result = await runGovernanceApproval(request);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('launch_failed');
  });
});
