import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import {
  DEFAULT_BEHAVIOR,
  DEFAULT_ENGINE,
  DEFAULT_MEMORY,
  DEFAULT_MODEL,
  DEFAULT_PROACTIVE,
  DEFAULT_TOOLS,
  DEFAULT_TTS,
} from '../config/defaults.js';
import type { OpenhomieConfig } from '../config/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { ContextBuilder } from './contextBuilder.js';

const baseConfig = (projectDir: string): OpenhomieConfig => ({
  schemaVersion: 1,
  model: DEFAULT_MODEL,
  engine: DEFAULT_ENGINE,
  behavior: { ...DEFAULT_BEHAVIOR, minDelayMs: 0, maxDelayMs: 0, debounceMs: 0 },
  proactive: DEFAULT_PROACTIVE,
  memory: { ...DEFAULT_MEMORY, enabled: false },
  tools: DEFAULT_TOOLS,
  tts: DEFAULT_TTS,
  paths: {
    projectDir,
    identityDir: path.join(projectDir, 'identity'),
    skillsDir: path.join(projectDir, 'skills'),
    dataDir: path.join(projectDir, 'data'),
    bootstrapDocs: [],
  },
});

describe('ContextBuilder bootstrap docs', () => {
  test('injects configured bootstrap docs and ignores missing files', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-bootstrap-docs-'));
    try {
      await mkdir(path.join(tmp, 'docs'), { recursive: true });
      await writeFile(path.join(tmp, 'docs', 'BEHAVIOR.md'), 'BEHAVIOR BODY', 'utf8');

      const cfg = baseConfig(tmp);
      cfg.paths.bootstrapDocs = ['docs/BEHAVIOR.md', 'docs/DOES_NOT_EXIST.md'];
      const cb = new ContextBuilder({ config: cfg });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m1'),
        authorId: 'operator',
        text: 'hey',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      const ctx = await cb.buildReactiveModelContext({
        msg,
        tools: undefined,
        toolsForMessage: () => undefined,
        toolGuidance: () => '',
        identityPrompt: 'IDENTITY',
      });

      expect(ctx.system).toContain('=== BOOTSTRAP DOCS (DATA) ===');
      expect(ctx.system).toContain('<external title="bootstrap_doc:docs/BEHAVIOR.md">');
      expect(ctx.system).toContain('BEHAVIOR BODY');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
