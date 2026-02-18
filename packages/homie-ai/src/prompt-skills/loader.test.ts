import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { indexPromptSkillsFromDirectory } from './loader.js';

const writeSkill = async (dir: string, name: string, text: string): Promise<void> => {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), text, 'utf8');
};

describe('prompt skill loader', () => {
  test('indexes valid SKILL.md (name matches dir) and reads homie tuning', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-prompt-skills-'));
    try {
      const promptDir = path.join(tmp, 'prompt');
      await mkdir(promptDir, { recursive: true });

      await writeSkill(
        promptDir,
        'group-discipline',
        [
          '---',
          'name: group-discipline',
          'description: Enforce one-message group discipline.',
          'homie:',
          '  scope: group',
          '  alwaysInclude: true',
          '  keywords: ["thread", "reply"]',
          '  priority: 10',
          '---',
          '',
          '# Group discipline',
          '',
          'One message max.',
          '',
        ].join('\n'),
      );

      const indexed = await indexPromptSkillsFromDirectory(promptDir, { throwOnError: true });
      expect(indexed.length).toBe(1);
      expect(indexed[0]?.name).toBe('group-discipline');
      expect(indexed[0]?.scope).toBe('group');
      expect(indexed[0]?.alwaysInclude).toBe(true);
      expect(indexed[0]?.priority).toBe(10);
      expect(indexed[0]?.keywords).toContain('thread');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('skips invalid SKILL.md by default (does not crash)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-prompt-skills-invalid-'));
    try {
      const promptDir = path.join(tmp, 'prompt');
      await mkdir(promptDir, { recursive: true });

      // Missing description -> invalid per spec
      await writeSkill(
        promptDir,
        'broken-skill',
        ['---', 'name: broken-skill', '---', '', 'body'].join('\n'),
      );

      const indexed = await indexPromptSkillsFromDirectory(promptDir);
      expect(indexed).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('enforces allowedBaseDir boundary when provided', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-prompt-skills-boundary-'));
    try {
      const skillsDir = path.join(tmp, 'skills');
      const outside = path.join(tmp, 'outside-prompt');
      await mkdir(skillsDir, { recursive: true });
      await mkdir(outside, { recursive: true });

      await expect(
        indexPromptSkillsFromDirectory(outside, { allowedBaseDir: skillsDir, throwOnError: true }),
      ).rejects.toThrow(/must be within allowed base dir/u);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
