import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const DEPLOY_PHASES = [
  'validate',
  'funding_gate',
  'provision',
  'bootstrap',
  'deploy_runtime',
  'verify',
  'done',
] as const;

export type DeployPhase = (typeof DEPLOY_PHASES)[number];

const DeployStateSchema = z.object({
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

export type DeployState = z.infer<typeof DeployStateSchema>;

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
  const raw = await readFile(statePath, 'utf8').catch(() => null);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  const validated = DeployStateSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Invalid deploy state file (${statePath}): ${validated.error.message}`);
  }
  return validated.data;
};

export const saveDeployState = async (state: DeployState): Promise<void> => {
  await mkdir(path.dirname(state.statePath), { recursive: true });
  const next: DeployState = {
    ...state,
    updatedAtIso: new Date().toISOString(),
  };
  await writeFile(state.statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
};

export const updateDeployState = async (
  statePath: string,
  updater: (current: DeployState) => DeployState,
): Promise<DeployState> => {
  const current = (await loadDeployState(statePath)) ?? createInitialDeployStateFromStatePath(statePath);
  const next = updater(current);
  await saveDeployState(next);
  return next;
};

const createInitialDeployStateFromStatePath = (statePath: string): DeployState => {
  const projectDir = path.dirname(path.dirname(statePath));
  return createInitialDeployState({
    projectDir,
    configPath: path.join(projectDir, 'homie.toml'),
    statePath,
  });
};

export const recordDeployError = async (statePath: string, message: string): Promise<DeployState> => {
  return await updateDeployState(statePath, (current) => ({
    ...current,
    lastError: {
      message,
      atIso: new Date().toISOString(),
    },
  }));
};

export const clearDeployState = async (statePath: string): Promise<void> => {
  await rm(statePath, { force: true });
};

export const withPhase = (state: DeployState, phase: DeployPhase): DeployState => ({
  ...state,
  phase,
});

