import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens } from '../util/tokens.js';
import { loadIdentityPackage } from './load.js';
import { composeIdentityPrompt } from './prompt.js';

const makeIdentityDir = async (): Promise<{
  identityDir: string;
  cleanup: () => Promise<void>;
}> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-identity-'));
  const cleanup = async () => rm(dir, { recursive: true, force: true });
  return { identityDir: dir, cleanup };
};

describe('identity loader', () => {
  test('loads all identity files and composes a prompt', async () => {
    const { identityDir, cleanup } = await makeIdentityDir();
    try {
      await writeFile(path.join(identityDir, 'SOUL.md'), 'soul content', 'utf8');
      await writeFile(path.join(identityDir, 'STYLE.md'), 'style content', 'utf8');
      await writeFile(path.join(identityDir, 'USER.md'), 'user content', 'utf8');
      await writeFile(path.join(identityDir, 'first-meeting.md'), 'hi', 'utf8');
      await writeFile(path.join(identityDir, 'AGENTS.md'), 'agents extension content', 'utf8');
      await writeFile(path.join(identityDir, 'EXAMPLES.md'), 'example tone content', 'utf8');
      await writeFile(
        path.join(identityDir, 'personality.json'),
        JSON.stringify({
          traits: ['dry', 'warm', 'fast replies'],
          voiceRules: ['short sentences', 'no assistant-y phrases'],
          antiPatterns: ['sycophantic praise'],
        }),
        'utf8',
      );

      const identity = await loadIdentityPackage(identityDir);
      expect(identity.soul).toContain('soul');
      expect(identity.personality.traits.length).toBeGreaterThan(0);
      expect(identity.agentsDoc).toContain('agents extension');
      expect(identity.examplesDoc).toContain('example tone');

      const maxTokens = 1200;
      const prompt = composeIdentityPrompt(identity, { maxTokens });
      expect(prompt).toContain('HOMIE IDENTITY LAYERS');
      expect(prompt).toContain('STYLE');
      expect(prompt).toContain('AGENTS EXTENSIONS');
      expect(prompt).toContain('Examples are for tone reference only');
      expect(prompt.length).toBeGreaterThan(10);
      expect(estimateTokens(prompt)).toBeLessThanOrEqual(maxTokens);
    } finally {
      await cleanup();
    }
  });

  test('missing required files include expected path', async () => {
    const { identityDir, cleanup } = await makeIdentityDir();
    try {
      // Intentionally omit SOUL.md
      await writeFile(path.join(identityDir, 'STYLE.md'), 'style content', 'utf8');
      await writeFile(path.join(identityDir, 'USER.md'), 'user content', 'utf8');
      await writeFile(path.join(identityDir, 'first-meeting.md'), 'hi', 'utf8');
      await writeFile(
        path.join(identityDir, 'personality.json'),
        JSON.stringify({ traits: ['dry'], voiceRules: [], antiPatterns: [] }),
        'utf8',
      );

      await expect(loadIdentityPackage(identityDir)).rejects.toThrow('SOUL.md');
      await expect(loadIdentityPackage(identityDir)).rejects.toThrow('expected');
    } finally {
      await cleanup();
    }
  });

  test('rejects identity file symlinks that resolve outside identityDir', async () => {
    const { identityDir, cleanup } = await makeIdentityDir();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'homie-identity-outside-'));
    try {
      const outsideSoul = path.join(outside, 'SOUL.md');
      await writeFile(outsideSoul, 'outside soul', 'utf8');
      await symlink(outsideSoul, path.join(identityDir, 'SOUL.md'));

      await writeFile(path.join(identityDir, 'STYLE.md'), 'style content', 'utf8');
      await writeFile(path.join(identityDir, 'USER.md'), 'user content', 'utf8');
      await writeFile(path.join(identityDir, 'first-meeting.md'), 'hi', 'utf8');
      await writeFile(
        path.join(identityDir, 'personality.json'),
        JSON.stringify({ traits: ['dry'], voiceRules: [], antiPatterns: [] }),
        'utf8',
      );

      await expect(loadIdentityPackage(identityDir)).rejects.toThrow('resolve within identityDir');
    } finally {
      await cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });
});
