import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createToolRegistry } from './registry.js';

describe('createToolRegistry identity tools', () => {
  test('loads tools from identityDir/tools and tags source=identity', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-identity-tools-'));
    const identityDir = path.join(tmp, 'identity');
    const toolsDir = path.join(identityDir, 'tools', 'self-improvement');
    try {
      await mkdir(toolsDir, { recursive: true });
      await writeFile(
        path.join(toolsDir, 'index.js'),
        [
          'export const tools = [',
          '  {',
          "    name: 'identity_ping',",
          "    tier: 'safe',",
          "    description: 'ping from identity tools',",
          "    guidance: 'Use this tool only when the user explicitly asks to test identity tools.',",
          '    timeoutMs: 1000,',
          '    inputSchema: { safeParse: (x) => ({ success: true, data: x }) },',
          "    execute: () => 'ok',",
          '  }',
          '];',
          '',
        ].join('\n'),
        'utf8',
      );

      const reg = await createToolRegistry({
        builtins: false,
        identityDir,
      });
      // biome-ignore lint/complexity/useLiteralKeys: Tool registry is an index signature.
      const tool = reg.all['identity_ping'];
      expect(tool).toBeTruthy();
      expect(tool?.source).toBe('identity');
      expect(tool?.guidance).toContain('identity tools');
      expect(tool?.timeoutMs).toBe(1000);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
