import { describe, expect, test } from 'bun:test';

import type { IncomingMessage } from '../agent/types.js';
import type { OpenhomieToolsConfig } from '../config/types.js';
import { buildToolGuidance, filterToolsForMessage } from './policy.js';
import type { ToolDef } from './types.js';

const stubTool = (overrides: Partial<ToolDef> & { name: string }): ToolDef => ({
  tier: 'safe',
  description: 'stub',
  inputSchema: {} as ToolDef['inputSchema'],
  execute: () => 'ok',
  ...overrides,
});

const stubMsg = (overrides?: Partial<IncomingMessage>): IncomingMessage =>
  ({
    channel: 'signal',
    chatId: 'signal:dm:+1',
    messageId: 'm1',
    authorId: '+1',
    text: 'hi',
    isGroup: false,
    isOperator: false,
    timestampMs: Date.now(),
    ...overrides,
  }) as IncomingMessage;

const defaultToolsConfig: OpenhomieToolsConfig = {
  restricted: { enabledForOperator: true, allowlist: [] },
  dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
};

describe('tools/policy', () => {
  test('returns undefined for empty tools', () => {
    expect(filterToolsForMessage([], stubMsg(), defaultToolsConfig)).toBeUndefined();
    expect(filterToolsForMessage(undefined, stubMsg(), defaultToolsConfig)).toBeUndefined();
  });

  test('non-operator sees safe tools; blocks filesystem/subprocess', () => {
    const tools = [
      stubTool({ name: 'calc', tier: 'safe' }),
      stubTool({ name: 'web', tier: 'safe', effects: ['network'] }),
      stubTool({ name: 'fs', tier: 'safe', effects: ['filesystem'] }),
      stubTool({ name: 'shell', tier: 'restricted' }),
    ];
    const result = filterToolsForMessage(tools, stubMsg(), defaultToolsConfig);
    expect(result?.map((t) => t.name)).toEqual(['calc', 'web']);
  });

  test('operator sees all tools regardless of effects', () => {
    const tools = [
      stubTool({ name: 'web', tier: 'safe', effects: ['network'] }),
      stubTool({ name: 'shell', tier: 'restricted' }),
    ];
    const result = filterToolsForMessage(tools, stubMsg({ isOperator: true }), defaultToolsConfig);
    expect(result?.map((t) => t.name)).toEqual(['web', 'shell']);
  });

  test('buildToolGuidance includes effect-based policy lines', () => {
    const tools = [
      stubTool({ name: 'web', effects: ['network'] }),
      stubTool({ name: 'fs', effects: ['filesystem'] }),
    ];
    const guidance = buildToolGuidance(tools);
    expect(guidance).toContain('TOOL GUIDANCE');
    expect(guidance).toContain('network tools');
    expect(guidance).toContain('filesystem tools');
  });

  test('buildToolGuidance returns empty for no tools', () => {
    expect(buildToolGuidance(undefined)).toBe('');
    expect(buildToolGuidance([])).toBe('');
  });

  test('buildToolGuidance includes per-tool guidance', () => {
    const tools = [stubTool({ name: 'calc', guidance: 'Use for math only' })];
    const guidance = buildToolGuidance(tools);
    expect(guidance).toContain('calc: Use for math only');
  });
});
