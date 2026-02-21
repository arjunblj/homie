import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearDeployState,
  createInitialDeployState,
  defaultDeployStatePath,
  loadDeployState,
  recordDeployError,
  saveDeployState,
  updateDeployState,
  withPhase,
} from './deployState.js';

describe('deployState', () => {
  test('saves and loads deploy state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    try {
      const initial = createInitialDeployState({
        projectDir: dir,
        configPath: path.join(dir, 'homie.toml'),
        statePath,
      });
      await saveDeployState(withPhase(initial, 'provision'));
      const loaded = await loadDeployState(statePath);
      expect(loaded?.phase).toBe('provision');
      expect(loaded?.statePath).toBe(statePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('updateDeployState creates file when absent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-update-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    try {
      await updateDeployState(statePath, (current) => ({
        ...current,
        phase: 'verify',
      }));
      const loaded = await loadDeployState(statePath);
      expect(loaded?.phase).toBe('verify');
      const raw = await readFile(statePath, 'utf8');
      expect(raw).toContain('"phase": "verify"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('clearDeployState removes state file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-clear-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    try {
      const initial = createInitialDeployState({
        projectDir: dir,
        configPath: path.join(dir, 'homie.toml'),
        statePath,
      });
      await saveDeployState(initial);
      await clearDeployState(statePath);
      const loaded = await loadDeployState(statePath);
      expect(loaded).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('recordDeployError requires an existing state file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-error-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    try {
      await expect(recordDeployError(statePath, 'boom')).rejects.toThrow('state file not found');
      const loaded = await loadDeployState(statePath);
      expect(loaded).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('recordDeployError stores error details on existing state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-error-store-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    try {
      const initial = createInitialDeployState({
        projectDir: dir,
        configPath: path.join(dir, 'homie.toml'),
        statePath,
      });
      await saveDeployState(initial);
      const updated = await recordDeployError(statePath, 'disk full');
      expect(updated.lastError?.message).toBe('disk full');
      const loaded = await loadDeployState(statePath);
      expect(loaded?.lastError?.message).toBe('disk full');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('handles concurrent updates and removes lock file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-concurrent-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    try {
      const initial = createInitialDeployState({
        projectDir: dir,
        configPath: path.join(dir, 'homie.toml'),
        statePath,
      });
      await saveDeployState(initial);

      await Promise.all(
        Array.from({ length: 24 }, (_unused, idx) =>
          updateDeployState(statePath, (current) => ({
            ...current,
            phase: idx % 2 === 0 ? 'bootstrap' : 'verify',
            lastError: {
              message: `err-${idx}`,
              atIso: new Date().toISOString(),
            },
          })),
        ),
      );

      const loaded = await loadDeployState(statePath);
      expect(loaded).not.toBeNull();
      expect(loaded?.lastError?.message.startsWith('err-')).toBeTrue();
      const lockFile = await readFile(`${statePath}.lock`, 'utf8').catch(() => null);
      expect(lockFile).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loadDeployState rejects invalid payloads', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-invalid-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    try {
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, '{"version":2}', 'utf8');
      await expect(loadDeployState(statePath)).rejects.toThrow('Invalid deploy state file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loadDeployState rejects malformed json with actionable error', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-malformed-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    try {
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, '{"version": 1, bad', 'utf8');
      await expect(loadDeployState(statePath)).rejects.toThrow('Malformed deploy state file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loadDeployState surfaces non-ENOENT filesystem errors', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-fs-error-'));
    const statePath = path.join(dir, 'not-a-file');
    try {
      await mkdir(statePath, { recursive: true });
      await expect(loadDeployState(statePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('releases lock when updater throws', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-lock-release-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    try {
      const initial = createInitialDeployState({
        projectDir: dir,
        configPath: path.join(dir, 'homie.toml'),
        statePath,
      });
      await saveDeployState(initial);

      await expect(
        updateDeployState(statePath, () => {
          throw new Error('updater failed');
        }),
      ).rejects.toThrow('updater failed');

      await updateDeployState(statePath, (current) => ({
        ...current,
        phase: 'done',
      }));
      const loaded = await loadDeployState(statePath);
      expect(loaded?.phase).toBe('done');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('clears stale lock files before write', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-deploy-state-stale-lock-'));
    const statePath = defaultDeployStatePath(path.join(dir, 'data'));
    const lockPath = `${statePath}.lock`;
    try {
      const initial = createInitialDeployState({
        projectDir: dir,
        configPath: path.join(dir, 'homie.toml'),
        statePath,
      });
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, 'stale', 'utf8');
      const staleTime = new Date(Date.now() - 120_000);
      await utimes(lockPath, staleTime, staleTime);

      await saveDeployState(initial);
      const loaded = await loadDeployState(statePath);
      expect(loaded?.phase).toBe('validate');
      const lingeringLock = await readFile(lockPath, 'utf8').catch(() => null);
      expect(lingeringLock).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
