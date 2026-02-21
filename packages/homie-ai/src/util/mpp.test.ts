import { describe, expect, test } from 'bun:test';
import {
  deriveMppWalletAddress,
  MPP_KEY_PATTERN,
  normalizeHttpUrl,
  normalizeMppPrivateKey,
  resolveMppMaxDeposit,
  resolveMppRpcUrl,
} from './mpp.js';

describe('normalizeHttpUrl', () => {
  test('prepends http:// when no protocol present', () => {
    expect(normalizeHttpUrl('localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeHttpUrl('127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
  });

  test('preserves existing protocol', () => {
    expect(normalizeHttpUrl('https://mpp.tempo.xyz')).toBe('https://mpp.tempo.xyz');
    expect(normalizeHttpUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  test('trims whitespace and strips trailing slashes', () => {
    expect(normalizeHttpUrl('  http://foo.com/  ')).toBe('http://foo.com');
    expect(normalizeHttpUrl('http://bar.com///')).toBe('http://bar.com');
  });

  test('returns empty string for empty input', () => {
    expect(normalizeHttpUrl('')).toBe('');
    expect(normalizeHttpUrl('   ')).toBe('');
  });

  test('returns empty string for invalid urls', () => {
    expect(normalizeHttpUrl('http://[invalid')).toBe('');
    expect(normalizeHttpUrl('javascript:alert(1)')).toBe('');
  });
});

describe('MPP_KEY_PATTERN', () => {
  test('matches valid 0x-prefixed 64-char hex strings', () => {
    const valid = `0x${'a'.repeat(64)}`;
    expect(MPP_KEY_PATTERN.test(valid)).toBeTrue();
  });

  test('rejects invalid keys', () => {
    expect(MPP_KEY_PATTERN.test('abc123')).toBeFalse();
    expect(MPP_KEY_PATTERN.test(`0x${'g'.repeat(64)}`)).toBeFalse();
    expect(MPP_KEY_PATTERN.test(`0x${'a'.repeat(63)}`)).toBeFalse();
    expect(MPP_KEY_PATTERN.test('')).toBeFalse();
  });
});

describe('normalizeMppPrivateKey', () => {
  test('normalizes valid keys and trims whitespace', () => {
    const key = ` 0x${'a'.repeat(64)} `;
    expect(normalizeMppPrivateKey(key)).toBe(`0x${'a'.repeat(64)}`);
  });

  test('returns undefined for invalid keys', () => {
    expect(normalizeMppPrivateKey('')).toBeUndefined();
    expect(normalizeMppPrivateKey('0x123')).toBeUndefined();
    expect(normalizeMppPrivateKey(undefined)).toBeUndefined();
  });
});

describe('deriveMppWalletAddress', () => {
  test('derives wallet address from valid private key', () => {
    const address = deriveMppWalletAddress(`0x${'1'.repeat(64)}`);
    expect(address).toBe('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
  });

  test('returns undefined for invalid private key', () => {
    expect(deriveMppWalletAddress('bad-key')).toBeUndefined();
    expect(deriveMppWalletAddress(undefined)).toBeUndefined();
  });
});

describe('resolveMppRpcUrl', () => {
  test('prefers MPP_RPC_URL then MPPX_RPC_URL then ETH_RPC_URL', () => {
    expect(
      resolveMppRpcUrl({
        MPP_RPC_URL: 'https://a.example',
        MPPX_RPC_URL: 'https://b.example',
        ETH_RPC_URL: 'https://c.example',
      }),
    ).toBe('https://a.example');
    expect(
      resolveMppRpcUrl({
        MPPX_RPC_URL: 'https://b.example',
        ETH_RPC_URL: 'https://c.example',
      }),
    ).toBe('https://b.example');
    expect(resolveMppRpcUrl({ ETH_RPC_URL: 'https://c.example' })).toBe('https://c.example');
  });

  test('trims and unquotes env values', () => {
    expect(resolveMppRpcUrl({ ETH_RPC_URL: " 'https://rpc.example' " })).toBe(
      'https://rpc.example',
    );
  });
});

describe('resolveMppMaxDeposit', () => {
  test('uses fallback when unset and normalizes positive numbers', () => {
    expect(resolveMppMaxDeposit(undefined, '0.1')).toBe('0.1');
    expect(resolveMppMaxDeposit('10', '0.1')).toBe('10');
    expect(resolveMppMaxDeposit(' 0.25 ', '0.1')).toBe('0.25');
  });

  test('throws for non-positive values', () => {
    expect(() => resolveMppMaxDeposit('0', '0.1')).toThrow('Invalid MPP_MAX_DEPOSIT');
    expect(() => resolveMppMaxDeposit('-1', '0.1')).toThrow('Invalid MPP_MAX_DEPOSIT');
    expect(() => resolveMppMaxDeposit('abc', '0.1')).toThrow('Invalid MPP_MAX_DEPOSIT');
  });
});
