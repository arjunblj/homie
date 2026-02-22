import { describe, expect } from 'bun:test';
import fc from 'fast-check';
import { z } from 'zod';

import type { IncomingMessage } from '../agent/types.js';
import type { OpenhomieToolsConfig } from '../config/types.js';
import { fcPropertyTest } from '../testing/fc.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { filterToolsForMessage } from './policy.js';
import type { ToolDef, ToolEffect, ToolTier } from './types.js';

describe('tools/policy (property)', () => {
  const tool = (t: {
    name: string;
    tier: ToolTier;
    effects?: readonly ToolEffect[] | undefined;
  }): ToolDef => ({
    name: t.name,
    tier: t.tier,
    description: 'test tool',
    ...(t.effects ? { effects: t.effects } : {}),
    inputSchema: z.any(),
    execute: () => undefined,
  });

  const msg = (overrides: Partial<IncomingMessage>): IncomingMessage => ({
    channel: 'cli',
    chatId: asChatId('cli:test'),
    messageId: asMessageId('cli:m'),
    authorId: 'u',
    text: 'hi',
    isGroup: false,
    isOperator: false,
    timestampMs: 0,
    ...overrides,
  });

  const config = (overrides?: Partial<OpenhomieToolsConfig>): OpenhomieToolsConfig => ({
    restricted: { enabledForOperator: true, allowlist: [] },
    dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
    ...overrides,
  });

  const toolArb = fc.record({
    name: fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/u),
    tier: fc.constantFrom('safe', 'restricted', 'dangerous' as const),
    effects: fc.option(
      fc.uniqueArray(fc.constantFrom('network', 'filesystem', 'subprocess' as const), {
        maxLength: 3,
      }),
      { nil: undefined },
    ),
  });

  fcPropertyTest(
    'non-operator never receives restricted/dangerous tools (tier gating)',
    fc.array(toolArb, { minLength: 0, maxLength: 40 }),
    (tools) => {
      const out = filterToolsForMessage(tools.map(tool), msg({ isOperator: false }), config());
      if (!out) return;
      expect(out.every((t) => t.tier === 'safe')).toBe(true);
    },
  );

  fcPropertyTest(
    'non-operator never receives filesystem/subprocess effects (effect gating)',
    fc.array(toolArb, { minLength: 0, maxLength: 40 }),
    (tools) => {
      const out = filterToolsForMessage(tools.map(tool), msg({ isOperator: false }), config());
      if (!out) return;
      for (const t of out) {
        const eff = t.effects ?? [];
        expect(eff.includes('filesystem')).toBe(false);
        expect(eff.includes('subprocess')).toBe(false);
      }
    },
  );

  fcPropertyTest(
    'operator restricted allowlist semantics are deny-by-default when non-empty',
    fc.record({
      tools: fc.uniqueArray(toolArb, { minLength: 0, maxLength: 40, selector: (t) => t.name }),
      allowlist: fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/u), {
        minLength: 1,
        maxLength: 10,
      }),
    }),
    ({ tools, allowlist }) => {
      const out = filterToolsForMessage(
        tools.map(tool),
        msg({ isOperator: true }),
        config({
          restricted: { enabledForOperator: true, allowlist },
          dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
        }),
      );
      const allowed = new Set(allowlist);
      for (const t of out ?? []) {
        if (t.tier === 'restricted') expect(allowed.has(t.name)).toBe(true);
      }
    },
  );

  fcPropertyTest(
    'operator dangerous allowAll permits all dangerous tools when enabled',
    fc.array(toolArb, { minLength: 0, maxLength: 40 }),
    (tools) => {
      const out = filterToolsForMessage(
        tools.map(tool),
        msg({ isOperator: true }),
        config({
          restricted: { enabledForOperator: false, allowlist: [] },
          dangerous: { enabledForOperator: true, allowAll: true, allowlist: [] },
        }),
      );
      const inDangerous = tools.filter((t) => t.tier === 'dangerous').map((t) => t.name);
      const outDangerous = (out ?? []).filter((t) => t.tier === 'dangerous').map((t) => t.name);
      // Effect gating does not apply to operators.
      expect(new Set(outDangerous)).toEqual(new Set(inDangerous));
    },
  );
});
