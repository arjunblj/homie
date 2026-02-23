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
import {
  buildPromptSkillsSection,
  indexPromptSkillsFromDirectory,
} from '../prompt-skills/loader.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { ContextBuilder } from './contextBuilder.js';

const baseConfig = (projectDir: string, skillsDir: string): OpenhomieConfig => ({
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
    skillsDir,
    dataDir: path.join(projectDir, 'data'),
    bootstrapDocs: [],
  },
});

describe('ContextBuilder prompt skills', () => {
  test('injects only group-safe prompt skills in group turns', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-prompt-skill-inject-'));
    try {
      const skillsDir = path.join(tmp, 'skills');
      const promptDir = path.join(skillsDir, 'prompt');
      await mkdir(promptDir, { recursive: true });

      await mkdir(path.join(promptDir, 'group-discipline'), { recursive: true });
      await writeFile(
        path.join(promptDir, 'group-discipline', 'SKILL.md'),
        [
          '---',
          'name: group-discipline',
          'description: Group-safe behavior rules.',
          'homie:',
          '  scope: group',
          '  alwaysInclude: true',
          '---',
          '',
          'Group turns must be one short message.',
        ].join('\n'),
        'utf8',
      );

      await mkdir(path.join(promptDir, 'dm-only'), { recursive: true });
      await writeFile(
        path.join(promptDir, 'dm-only', 'SKILL.md'),
        [
          '---',
          'name: dm-only',
          'description: DM-only steering.',
          'homie:',
          '  scope: dm',
          '  alwaysInclude: true',
          '---',
          '',
          'DM ONLY BODY',
        ].join('\n'),
        'utf8',
      );

      const indexed = indexPromptSkillsFromDirectory(promptDir, { throwOnError: true });
      const promptSkillsSection = (sOpts: { msg: IncomingMessage; query: string }) =>
        buildPromptSkillsSection({
          indexed,
          msg: sOpts.msg,
          query: sOpts.query,
          maxTokens: 500,
        });
      const cfg = baseConfig(tmp, skillsDir);
      const cb = new ContextBuilder({ config: cfg, promptSkillsSection });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:group'),
        messageId: asMessageId('m1'),
        authorId: 'u1',
        authorDisplayName: 'User 1',
        text: 'hey',
        isGroup: true,
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

      expect(ctx.system).toContain('=== PROMPT SKILLS (LOCAL) ===');
      expect(ctx.system).toContain('group-discipline');
      expect(ctx.system).toContain('Group turns must be one short message.');
      expect(ctx.system).not.toContain('DM ONLY BODY');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
