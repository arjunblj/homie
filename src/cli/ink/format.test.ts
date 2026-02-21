import { describe, expect, test } from 'bun:test';

import {
  addUsage,
  classifyPaymentState,
  commandMatches,
  createMessage,
  EMPTY_USAGE,
  formatTurnReceiptCard,
  parseAttachArgs,
  paymentStateLabel,
  renderCard,
} from './format.js';
import type { PaymentState, TurnUsageSummary, UsageSummary } from './types.js';

describe('classifyPaymentState', () => {
  const cases: Array<[string, PaymentState]> = [
    ['Insufficient balance for transfer', 'insufficient_funds'],
    ['Payment Required (402)', 'insufficient_funds'],
    ['balance too low', 'insufficient_funds'],
    ['Wrong network selected', 'wrong_network'],
    ['Chain mismatch', 'wrong_network'],
    ['Error 4901: switch network', 'wrong_network'],
    ['Invalid private key detected', 'invalid_key_format'],
    ['Request timed out', 'timeout'],
    ['Operation aborted', 'timeout'],
    ['User cancelled the operation', 'cancelled'],
    ['Request denied by user', 'cancelled'],
    ['Rejected (4001)', 'cancelled'],
    ['Transaction interrupted', 'cancelled'],
    ['Host unreachable', 'endpoint_unreachable'],
    ['ECONNREFUSED', 'endpoint_unreachable'],
    ['fetch failed: ECONNRESET', 'endpoint_unreachable'],
    ['load balancer unreachable', 'endpoint_unreachable'],
    ['blockchain sync in progress', 'unknown'],
    ['Transaction failed', 'failed'],
    ['Unknown error occurred', 'failed'],
    ['Something completely unexpected', 'unknown'],
  ];

  for (const [message, expected] of cases) {
    test(`"${message}" → ${expected}`, () => {
      expect(classifyPaymentState(message)).toBe(expected);
    });
  }
});

describe('paymentStateLabel', () => {
  const cases: Array<[PaymentState, string]> = [
    ['ready', 'ready'],
    ['pending', 'pending'],
    ['success', 'confirmed'],
    ['failed', 'failed'],
    ['insufficient_funds', 'insufficient funds'],
    ['wrong_network', 'wrong network'],
    ['timeout', 'timeout'],
    ['endpoint_unreachable', 'endpoint unreachable'],
    ['invalid_key_format', 'invalid key'],
    ['cancelled', 'cancelled'],
    ['unknown', 'unknown'],
  ];

  for (const [state, label] of cases) {
    test(`${state} → "${label}"`, () => {
      expect(paymentStateLabel(state)).toBe(label);
    });
  }
});

describe('addUsage', () => {
  test('sums all fields of two UsageSummary objects', () => {
    const a: UsageSummary = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 20,
      costUsd: 0.001,
    };
    const b: UsageSummary = {
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 30,
      cacheWriteTokens: 15,
      reasoningTokens: 40,
      costUsd: 0.002,
    };
    const result = addUsage(a, b);
    expect(result).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 40,
      cacheWriteTokens: 20,
      reasoningTokens: 60,
      costUsd: 0.003,
    });
  });

  test('adding EMPTY_USAGE is identity', () => {
    const a: UsageSummary = {
      inputTokens: 42,
      outputTokens: 7,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
      costUsd: 0.01,
    };
    expect(addUsage(a, EMPTY_USAGE)).toEqual(a);
  });
});

describe('createMessage', () => {
  test('creates a ChatMessage with correct fields', () => {
    const msg = createMessage('user', 'hello', false);
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
    expect(msg.isStreaming).toBe(false);
    expect(msg.id).toMatch(/^msg-/);
    expect(typeof msg.timestampMs).toBe('number');
  });

  test('generates unique ids', () => {
    const a = createMessage('assistant', 'a', true);
    const b = createMessage('assistant', 'b', true);
    expect(a.id).not.toBe(b.id);
  });

  test('accepts optional kind', () => {
    const msg = createMessage('meta', 'receipt info', false, { kind: 'receipt' });
    expect(msg.kind).toBe('receipt');
  });

  test('omits kind when not provided', () => {
    const msg = createMessage('assistant', 'hi', false);
    expect(msg.kind).toBeUndefined();
  });
});

describe('parseAttachArgs', () => {
  test('parses a valid path', () => {
    const result = parseAttachArgs('/attach ./foo.txt');
    expect(result).toEqual({
      attachment: { path: './foo.txt', displayName: 'foo.txt' },
      text: '',
    });
  });

  test('parses a quoted path with message', () => {
    const result = parseAttachArgs('/attach "./my file.txt" check this');
    expect(result).toEqual({
      attachment: { path: './my file.txt', displayName: 'my file.txt' },
      text: 'check this',
    });
  });

  test('returns error for missing path', () => {
    const result = parseAttachArgs('/attach');
    expect(result).toHaveProperty('error');
  });

  test('returns error for empty input after /attach', () => {
    const result = parseAttachArgs('/attach   ');
    expect(result).toHaveProperty('error');
  });
});

describe('commandMatches', () => {
  test('/h matches /help', () => {
    const matches = commandMatches('/h');
    expect(matches.some((m) => m.cmd === '/help')).toBe(true);
  });

  test('/exit matches exactly', () => {
    const matches = commandMatches('/exit');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.cmd).toBe('/exit');
  });

  test('plain text returns empty', () => {
    expect(commandMatches('hello')).toHaveLength(0);
  });

  test('bare "/" matches all commands', () => {
    const matches = commandMatches('/');
    expect(matches.length).toBeGreaterThan(1);
  });
});

describe('renderCard', () => {
  test('produces a string containing title and rows', () => {
    const card = renderCard('test card', ['row one', 'row two']);
    expect(card).toContain('test card');
    expect(card).toContain('row one');
    expect(card).toContain('row two');
    expect(card.split('\n').length).toBeGreaterThanOrEqual(4);
  });
});

describe('formatTurnReceiptCard', () => {
  const baseSummary: TurnUsageSummary = {
    llmCalls: 1,
    modelId: 'test-model',
    txHash: '0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    usage: {
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.005,
    },
  };

  test('compact mode produces a receipt card', () => {
    const compact = formatTurnReceiptCard(baseSummary, 'compact', 'success');
    expect(compact).toContain('payment receipt');
    expect(compact).toContain('confirmed');
  });

  test('verbose mode includes model and llm calls', () => {
    const verbose = formatTurnReceiptCard(baseSummary, 'verbose', 'success');
    expect(verbose).toContain('test-model');
    expect(verbose).toContain('llm calls');
  });

  test('verbose output is longer than compact', () => {
    const compact = formatTurnReceiptCard(baseSummary, 'compact', 'success');
    const verbose = formatTurnReceiptCard(baseSummary, 'verbose', 'success');
    expect(verbose.split('\n').length).toBeGreaterThan(compact.split('\n').length);
  });
});
