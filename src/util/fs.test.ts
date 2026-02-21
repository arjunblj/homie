import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fileExists, findUp, isDirectory, readTextFile } from './fs.js';

describe('util/fs', () => {
  test('fileExists and isDirectory', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-fs-'));
    try {
      const file = path.join(tmp, 'a.txt');
      await writeFile(file, 'hi', 'utf8');
      expect(await fileExists(file)).toBe(true);
      expect(await fileExists(path.join(tmp, 'missing'))).toBe(false);
      expect(await isDirectory(tmp)).toBe(true);
      expect(await isDirectory(file)).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('findUp finds a file in parent directories', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-findup-'));
    try {
      const root = path.join(tmp, 'root');
      const child = path.join(root, 'a', 'b');
      await mkdir(child, { recursive: true });
      await writeFile(path.join(root, 'homie.toml'), 'x', 'utf8');

      const found = await findUp('homie.toml', child);
      expect(found).toBe(path.join(root, 'homie.toml'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('readTextFile reads utf8', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-read-'));
    try {
      const file = path.join(tmp, 'a.txt');
      await writeFile(file, 'hello', 'utf8');
      expect(await readTextFile(file)).toBe('hello');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
