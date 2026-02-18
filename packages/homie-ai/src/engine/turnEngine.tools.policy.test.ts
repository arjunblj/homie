import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { DEFAULT_ENGINE, DEFAULT_MEMORY } from '../config/defaults.js';
import type { HomieConfig } from '../config/types.js';
import { defineTool } from '../tools/define.js';
import type { ToolDef } from '../tools/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

const writeIdentity = async (identityDir: string): Promise<void> => {
  await writeFile(path.join(identityDir, 'SOUL.md'), 'soul', 'utf8');
  await writeFile(path.join(identityDir, 'STYLE.md'), 'style', 'utf8');
  await writeFile(path.join(identityDir, 'USER.md'), 'user', 'utf8');
  await writeFile(path.join(identityDir, 'first-meeting.md'), 'hi', 'utf8');
  await writeFile(
    path.join(identityDir, 'personality.json'),
    JSON.stringify({ traits: ['x'], voiceRules: ['y'], antiPatterns: [] }),
    'utf8',
  );
};

const baseCfg = (
  tmp: string,
  identityDir: string,
  dataDir: string,
  dangerousEnabledForOperator: boolean,
): HomieConfig => ({
  schemaVersion: 1,
  model: { provider: { kind: 'anthropic' }, models: { default: 'm', fast: 'mf' } },
  engine: DEFAULT_ENGINE,
  behavior: {
    sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
    groupMaxChars: 240,
    dmMaxChars: 420,
    minDelayMs: 0,
    maxDelayMs: 0,
    debounceMs: 0,
  },
  proactive: {
    enabled: false,
    heartbeatIntervalMs: 1_800_000,
    maxPerDay: 1,
    maxPerWeek: 3,
    cooldownAfterUserMs: 7_200_000,
    pauseAfterIgnored: 2,
  },
  memory: DEFAULT_MEMORY,
  tools: {
    restricted: { enabledForOperator: true, allowlist: [] },
    dangerous: {
      enabledForOperator: dangerousEnabledForOperator,
      allowAll: false,
      allowlist: ['dangerous_one'],
    },
  },
  paths: { projectDir: tmp, identityDir, skillsDir: path.join(tmp, 'skills'), dataDir },
});

describe('TurnEngine tool tier policy', () => {
  test('non-operator only sees safe tools', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-tools-policy-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const safeTool: ToolDef = defineTool({
        name: 'safe_one',
        tier: 'safe',
        description: 'safe',
        inputSchema: z.object({}).strict(),
        execute: () => 'ok',
      });
      const restrictedTool: ToolDef = defineTool({
        name: 'restricted_one',
        tier: 'restricted',
        description: 'restricted',
        inputSchema: z.object({}).strict(),
        execute: () => 'ok',
      });
      const dangerousTool: ToolDef = defineTool({
        name: 'dangerous_one',
        tier: 'dangerous',
        description: 'dangerous',
        inputSchema: z.object({}).strict(),
        execute: () => 'ok',
      });

      let sawTools: string[] = [];
      const backend: LLMBackend = {
        async complete(params) {
          sawTools = (params.tools?.map((t) => t.name).sort() ?? []) as string[];
          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: baseCfg(tmp, identityDir, dataDir, true),
        backend,
        tools: [safeTool, restrictedTool, dangerousTool],
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const msg: IncomingMessage = {
        channel: 'signal',
        chatId: asChatId('signal:dm:+1'),
        messageId: asMessageId('m1'),
        authorId: '+1',
        authorDisplayName: 'u',
        text: 'hi',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      await engine.handleIncomingMessage(msg);
      expect(sawTools).toEqual(['safe_one']);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('operator can see restricted tools; dangerous requires shell enabled', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-tools-policy-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const safeTool: ToolDef = defineTool({
        name: 'safe_one',
        tier: 'safe',
        description: 'safe',
        inputSchema: z.object({}).strict(),
        execute: () => 'ok',
      });
      const restrictedTool: ToolDef = defineTool({
        name: 'restricted_one',
        tier: 'restricted',
        description: 'restricted',
        inputSchema: z.object({}).strict(),
        execute: () => 'ok',
      });
      const dangerousTool: ToolDef = defineTool({
        name: 'dangerous_one',
        tier: 'dangerous',
        description: 'dangerous',
        inputSchema: z.object({}).strict(),
        execute: () => 'ok',
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m1'),
        authorId: 'operator',
        authorDisplayName: 'operator',
        text: 'hi',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      let sawTools: string[] = [];
      const backend1: LLMBackend = {
        async complete(params) {
          sawTools = (params.tools?.map((t) => t.name).sort() ?? []) as string[];
          return { text: 'yo', steps: [] };
        },
      };
      const engine1 = new TurnEngine({
        config: baseCfg(tmp, identityDir, dataDir, false),
        backend: backend1,
        tools: [safeTool, restrictedTool, dangerousTool],
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });
      await engine1.handleIncomingMessage(msg);
      expect(sawTools).toEqual(['restricted_one', 'safe_one']);

      sawTools = [];
      const backend2: LLMBackend = {
        async complete(params) {
          sawTools = (params.tools?.map((t) => t.name).sort() ?? []) as string[];
          return { text: 'yo', steps: [] };
        },
      };
      const engine2 = new TurnEngine({
        config: baseCfg(tmp, identityDir, dataDir, true),
        backend: backend2,
        tools: [safeTool, restrictedTool, dangerousTool],
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });
      await engine2.handleIncomingMessage(msg);
      expect(sawTools).toEqual(['dangerous_one', 'restricted_one', 'safe_one']);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
