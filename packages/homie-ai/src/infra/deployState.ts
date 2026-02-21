import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

export const DEPLOY_PHASES: readonly [
  'validate',
  'funding_gate',
  'provision',
  'bootstrap',
  'deploy_runtime',
  'verify',
  'done',
] = [
  'validate',
  'funding_gate',
  'provision',
  'bootstrap',
  'deploy_runtime',
  'verify',
  'done',
] as const;

export type DeployPhase = (typeof DEPLOY_PHASES)[number];

export interface DeployState {
  version: 1;
  phase: DeployPhase;
  projectDir: string;
  configPath: string;
  statePath: string;
  createdAtIso: string;
  updatedAtIso: string;
  payment?:
    | {
        walletAddress: string;
        rootBaseUrl: string;
        provider: string;
      }
    | undefined;
  ssh?:
    | {
        privateKeyPath: string;
        publicKeyPath: string;
        keyId?: number | undefined;
        keyName?: string | undefined;
        fingerprint?: string | undefined;
        managedByDeploy?: boolean | undefined;
        hostKeyPins?: readonly string[] | undefined;
      }
    | undefined;
  droplet?:
    | {
        id?: number | undefined;
        name?: string | undefined;
        region?: string | undefined;
        size?: string | undefined;
        image?: string | undefined;
        ip?: string | undefined;
        status?: string | undefined;
      }
    | undefined;
  lastError?:
    | {
        message: string;
        atIso: string;
      }
    | undefined;
}

const DeployStateSchema: z.ZodType<DeployState> = z.object({
  version: z.literal(1),
  phase: z.enum(DEPLOY_PHASES),
  projectDir: z.string(),
  configPath: z.string(),
  statePath: z.string(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
  payment: z
    .object({
      walletAddress: z.string(),
      rootBaseUrl: z.string(),
      provider: z.string(),
    })
    .optional(),
  ssh: z
    .object({
      privateKeyPath: z.string(),
      publicKeyPath: z.string(),
      keyId: z.number().int().optional(),
      keyName: z.string().optional(),
      fingerprint: z.string().optional(),
      managedByDeploy: z.boolean().optional(),
      hostKeyPins: z.array(z.string()).optional(),
    })
    .optional(),
  droplet: z
    .object({
      id: z.number().int().optional(),
      name: z.string().optional(),
      region: z.string().optional(),
      size: z.string().optional(),
      image: z.string().optional(),
      ip: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
  lastError: z
    .object({
      message: z.string(),
      atIso: z.string(),
    })
    .optional(),
});

export const defaultDeployStatePath = (dataDir: string): string => {
  return path.join(dataDir, 'deploy.json');
};

export const createInitialDeployState = (input: {
  projectDir: string;
  configPath: string;
  statePath: string;
}): DeployState => {
  const now = new Date().toISOString();
  return {
    version: 1,
    phase: 'validate',
    projectDir: input.projectDir,
    configPath: input.configPath,
    statePath: input.statePath,
    createdAtIso: now,
    updatedAtIso: now,
  };
};

export const loadDeployState = async (statePath: string): Promise<DeployState | null> => {
  const raw = await readFile(statePath, 'utf8').catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw err;
  });
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed deploy state file (${statePath}): ${detail}`);
  }
  const validated = DeployStateSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Invalid deploy state file (${statePath}): ${validated.error.message}`);
  }
  return validated.data;
};

const STATE_LOCK_TIMEOUT_MS = 5_000;
const STATE_LOCK_RETRY_MS = 50;
const STATE_LOCK_STALE_MS = 30_000;

const stateLockPath = (statePath: string): string => `${statePath}.lock`;

const withDeployStateLock = async <T>(statePath: string, fn: () => Promise<T>): Promise<T> => {
  const lockPath = stateLockPath(statePath);
  await mkdir(path.dirname(statePath), { recursive: true });
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') throw err;
      const lockStats = await stat(lockPath).catch((_statErr) => null);
      if (lockStats && Date.now() - lockStats.mtimeMs > STATE_LOCK_STALE_MS) {
        await rm(lockPath, { force: true }).catch((_rmErr) => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring deploy state lock: ${lockPath}`);
      }
      await sleep(STATE_LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true }).catch((_err) => undefined);
  }
};

const saveDeployStateUnlocked = async (state: DeployState): Promise<void> => {
  await mkdir(path.dirname(state.statePath), { recursive: true });
  const next = DeployStateSchema.parse({
    ...state,
    updatedAtIso: new Date().toISOString(),
  });
  const tmpPath = `${state.statePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmpPath, state.statePath);
  } finally {
    await rm(tmpPath, { force: true }).catch((_err) => undefined);
  }
};

export const saveDeployState = async (state: DeployState): Promise<void> => {
  await withDeployStateLock(state.statePath, async () => {
    await saveDeployStateUnlocked(state);
  });
};

export const updateDeployState = async (
  statePath: string,
  updater: (current: DeployState) => DeployState,
): Promise<DeployState> => {
  return await withDeployStateLock(statePath, async () => {
    const current =
      (await loadDeployState(statePath)) ?? createInitialDeployStateFromStatePath(statePath);
    const next = updater(current);
    await saveDeployStateUnlocked(next);
    return next;
  });
};

const createInitialDeployStateFromStatePath = (statePath: string): DeployState => {
  const projectDir = path.dirname(path.dirname(statePath));
  return createInitialDeployState({
    projectDir,
    configPath: path.join(projectDir, 'homie.toml'),
    statePath,
  });
};

export const recordDeployError = async (
  statePath: string,
  message: string,
): Promise<DeployState> => {
  return await withDeployStateLock(statePath, async () => {
    const current = await loadDeployState(statePath);
    if (!current) {
      throw new Error(`Cannot record deploy error: state file not found at ${statePath}`);
    }
    const next: DeployState = {
      ...current,
      lastError: {
        message,
        atIso: new Date().toISOString(),
      },
    };
    await saveDeployStateUnlocked(next);
    return next;
  });
};

export const clearDeployState = async (statePath: string): Promise<void> => {
  await rm(statePath, { force: true });
};

export const withPhase = (state: DeployState, phase: DeployPhase): DeployState => ({
  ...state,
  phase,
});
