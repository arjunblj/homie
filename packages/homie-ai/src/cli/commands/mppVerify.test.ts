import { describe, expect, test } from 'bun:test';
import { classifyMppVerifyFailure, MppVerifyError, verifyMppModelAccess } from './mppVerify.js';

describe('verifyMppModelAccess', () => {
  test('fails with missing_key when env key is absent', async () => {
    const err = await verifyMppModelAccess({
      env: {},
      model: 'openai/gpt-4o-mini',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MppVerifyError);
    expect((err as MppVerifyError).failure.code).toBe('missing_key');
  });

  test('fails with invalid_key_format when key is malformed', async () => {
    const err = await verifyMppModelAccess({
      env: { MPP_PRIVATE_KEY: 'abc123' },
      model: 'openai/gpt-4o-mini',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MppVerifyError);
    expect((err as MppVerifyError).failure.code).toBe('invalid_key_format');
  });
});

describe('classifyMppVerifyFailure', () => {
  test('maps timeout-like failures', () => {
    const failure = classifyMppVerifyFailure(
      new Error('request aborted after timeout'),
      'wallet 0x123',
    );
    expect(failure.code).toBe('timeout');
  });

  test('maps insufficient funds failures', () => {
    const failure = classifyMppVerifyFailure(
      new Error('402 payment required: insufficient balance'),
      'wallet 0xabc',
    );
    expect(failure.code).toBe('insufficient_funds');
    expect(failure.nextStep).toContain('wallet 0xabc');
  });

  test('maps endpoint/network failures', () => {
    const failure = classifyMppVerifyFailure(
      new Error('fetch failed: ECONNREFUSED'),
      'wallet 0xabc',
    );
    expect(failure.code).toBe('endpoint_unreachable');
  });

  test('falls back to unknown', () => {
    const failure = classifyMppVerifyFailure(
      new Error('unexpected parser edge case'),
      'wallet 0xabc',
    );
    expect(failure.code).toBe('unknown');
  });
});
