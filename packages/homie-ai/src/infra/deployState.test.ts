import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearDeployState,
  createInitialDeployState,
  defaultDeployStatePath,
  loadDeployState,
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
});
