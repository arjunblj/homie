import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertEnvValue } from './env.js';

const tmp = () => join(tmpdir(), `env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe('upsertEnvValue', () => {
  const created: string[] = [];

  const makeTmp = async (content?: string): Promise<string> => {
    const p = tmp();
    if (content !== undefined) await Bun.write(p, content);
    created.push(p);
    return p;
  };

  afterEach(async () => {
    await Promise.all(created.map((p) => rm(p, { force: true })));
    created.length = 0;
  });

  test('inserts new key into empty file', async () => {
    const p = await makeTmp('');
    await upsertEnvValue(p, 'MY_KEY', 'hello');
    const out = await readFile(p, 'utf8');
    expect(out.trim()).toBe('MY_KEY=hello');
  });

  test('inserts new key into file with existing content', async () => {
    const p = await makeTmp('FOO=bar\n');
    await upsertEnvValue(p, 'BAZ', 'qux');
    const out = await readFile(p, 'utf8');
    expect(out).toContain('FOO=bar');
    expect(out).toContain('BAZ=qux');
  });

  test('replaces existing key', async () => {
    const p = await makeTmp('KEY=old\n');
    await upsertEnvValue(p, 'KEY', 'new');
    const out = await readFile(p, 'utf8');
    expect(out).toContain('KEY=new');
    expect(out).not.toContain('KEY=old');
  });

  test('handles duplicate keys (keeps first replacement)', async () => {
    const p = await makeTmp('KEY=1\nKEY=2\n');
    await upsertEnvValue(p, 'KEY', '3');
    const out = await readFile(p, 'utf8');
    const matches = out.match(/KEY=/g);
    expect(matches).toHaveLength(1);
    expect(out).toContain('KEY=3');
  });

  test("creates file when it doesn't exist", async () => {
    const p = tmp();
    created.push(p);
    await upsertEnvValue(p, 'NEW', 'val');
    const out = await readFile(p, 'utf8');
    expect(out.trim()).toBe('NEW=val');
  });

  test('preserves other lines and ordering', async () => {
    const p = await makeTmp('A=1\nB=2\nC=3\n');
    await upsertEnvValue(p, 'B', 'new');
    const lines = (await readFile(p, 'utf8')).trim().split('\n');
    expect(lines[0]).toBe('A=1');
    expect(lines[1]).toBe('B=new');
    expect(lines[2]).toBe('C=3');
  });
});
