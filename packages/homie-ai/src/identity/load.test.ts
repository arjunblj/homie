import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

      const prompt = composeIdentityPrompt(identity, { maxTokens: 500 });
      expect(prompt).toContain('HOMIE IDENTITY PACKAGE');
      expect(prompt).toContain('STYLE');
      expect(prompt.length).toBeGreaterThan(10);
    } finally {
      await cleanup();
    }
  });
});
