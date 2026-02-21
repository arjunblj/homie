import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as p from '@clack/prompts';
import qrcode from 'qrcode-terminal';
import { privateKeyToAccount } from 'viem/accounts';
import type { LoadedHomieConfig } from '../../config/load.js';
import { buildCloudInitUserData } from '../../infra/cloudInit.js';
import {
  clearDeployState,
  createInitialDeployState,
  DEPLOY_PHASES,
  type DeployPhase,
  type DeployState,
  defaultDeployStatePath,
  loadDeployState,
  recordDeployError,
  saveDeployState,
} from '../../infra/deployState.js';
import { MppDoClient, MppDoError } from '../../infra/mppDo.js';
import {
  generateSshKeyPair,
  openInteractiveSsh,
  scpCopy,
  sshExec,
  waitForSshReady,
} from '../../infra/ssh.js';
import { truncateOneLine } from '../../util/format.js';
import { fileExists, openUrl } from '../../util/fs.js';
import {
  deriveMppWalletAddress,
  normalizeMppPrivateKey,
  resolveMppMaxDeposit,
  resolveMppRpcUrl,
} from '../../util/mpp.js';
import { createPaymentSessionClient } from '../../wallet/payments.js';
import { createDefaultSpendPolicy } from '../../wallet/policy.js';
import type { AgentRuntimeWallet } from '../../wallet/types.js';
import type { GlobalOpts } from '../args.js';
import { DeployReporter, resolveDeployOutputMode } from './deployOutput.js';
import { MppVerifyError, verifyMppModelAccess } from './mppVerify.js';

interface DeployEnv extends NodeJS.ProcessEnv {
  MPP_PRIVATE_KEY?: string;
  MPP_MAX_DEPOSIT?: string;
  MPP_RPC_URL?: string;
  MPPX_RPC_URL?: string;
  ETH_RPC_URL?: string;
  HOMIE_DEPLOY_REGION?: string;
  HOMIE_DEPLOY_SIZE?: string;
  HOMIE_DEPLOY_IMAGE?: string;
  HOMIE_DEPLOY_REPO?: string;
  HOMIE_DEPLOY_REF?: string;
  HOMIE_DEPLOY_MAX_PER_REQUEST_USD?: string;
  HOMIE_DEPLOY_MAX_PER_DAY_USD?: string;
}

type DeployAction = 'apply' | 'status' | 'destroy' | 'ssh' | 'resume';

interface ParsedDeployArgs {
  action: DeployAction;
  dryRun: boolean;
  region?: string | undefined;
  size?: string | undefined;
  image?: string | undefined;
  name?: string | undefined;
}

const MPP_DOCS_URL = 'https://mpp.tempo.xyz/llms.txt';
const DEFAULT_DROPLET_IMAGE = 'ubuntu-24-04-x64';
const DEFAULT_REGION = 'nyc3';
const DEFAULT_SIZE = 's-1vcpu-1gb';
const DEFAULT_RUNTIME_IMAGE_TAG = 'homie-runtime:latest';
const DEFAULT_RUNTIME_REPO = 'https://github.com/arjunblj/homie.git';
const DEFAULT_RUNTIME_REF = 'main';
const DEFAULT_DEPLOY_MAX_DEPOSIT = '0.1';
const DEFAULT_DEPLOY_MAX_PER_REQUEST_USD = 25;
const DEFAULT_DEPLOY_MAX_PER_DAY_USD = 50;
const REMOTE_RUNTIME_DIR = '/opt/homie';
const REMOTE_RUNTIME_USER = 'homie';
const REMOTE_RUNTIME_SOURCE_DIR = `${REMOTE_RUNTIME_DIR}/runtime-src`;
const DROPLET_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const parseDeployArgs = (cmdArgs: readonly string[]): ParsedDeployArgs => {
  const args = [...cmdArgs];
  let action: DeployAction = 'apply';
  let dryRun = false;
  let region: string | undefined;
  let size: string | undefined;
  let image: string | undefined;
  let name: string | undefined;

  if (args.length > 0) {
    const first = args[0];
    if (first && !first.startsWith('-')) {
      if (
        first === 'apply' ||
        first === 'status' ||
        first === 'destroy' ||
        first === 'ssh' ||
        first === 'resume'
      ) {
        action = first;
        args.shift();
      } else {
        throw new Error(`homie deploy: unknown subcommand "${first}"`);
      }
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current) continue;
    if (current === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (current.startsWith('--region=')) {
      region = current.slice('--region='.length).trim();
      continue;
    }
    if (current.startsWith('--size=')) {
      size = current.slice('--size='.length).trim();
      continue;
    }
    if (current.startsWith('--image=')) {
      image = current.slice('--image='.length).trim();
      continue;
    }
    if (current.startsWith('--name=')) {
      name = current.slice('--name='.length).trim();
      continue;
    }
    throw new Error(`homie deploy: unknown option "${current}"`);
  }

  if (action !== 'apply' && (dryRun || region || size || image || name)) {
    throw new Error(`homie deploy: options are only valid for apply (received "${action}")`);
  }

  return { action, dryRun, region, size, image, name };
};

const shouldUseUnicode = (): boolean => {
  const env = process.env as NodeJS.ProcessEnv & { TERM?: string | undefined };
  const term = env.TERM?.toLowerCase() ?? '';
  if (term === 'dumb') return false;
  return true;
};

const shouldUseColor = (opts: GlobalOpts): boolean => {
  if (opts.noColor) return false;
  const env = process.env as NodeJS.ProcessEnv & { NO_COLOR?: string | undefined };
  if (env.NO_COLOR) return false;
  return Boolean(process.stderr.isTTY);
};

const requireMppWallet = (env: DeployEnv): AgentRuntimeWallet => {
  const privateKey = normalizeMppPrivateKey(env.MPP_PRIVATE_KEY);
  if (!privateKey) {
    throw new Error(
      'homie deploy: missing/invalid MPP_PRIVATE_KEY (expected 0x-prefixed 64-byte hex key)',
    );
  }
  return {
    privateKey,
    address: privateKeyToAccount(privateKey).address,
  };
};

const pollDropletReady = async (
  client: MppDoClient,
  dropletId: number,
): Promise<{
  id: number;
  ip: string;
  status: string;
}> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const droplet = await client.getDroplet(dropletId);
    const ip = MppDoClient.dropletPublicIpv4(droplet);
    if (droplet.status === 'active' && ip) {
      return { id: droplet.id, ip, status: droplet.status };
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for droplet ${String(dropletId)} to become active`);
};

const isRegionCapacityError = (error: unknown): boolean => {
  if (!(error instanceof MppDoError)) return false;
  const low = error.detail.toLowerCase();
  if (error.kind !== 'invalid_request' && error.kind !== 'not_found' && error.kind !== 'unknown') {
    return false;
  }
  return (
    low.includes('subnet status') ||
    low.includes('capacity') ||
    low.includes('out of stock') ||
    low.includes('resource not available')
  );
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const resolvePositiveUsdLimit = (
  value: string | undefined,
  fallback: number,
  variableName: string,
): number => {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${variableName}: expected a positive number`);
  }
  return parsed;
};

const phaseIndex = (phase: DeployPhase): number => DEPLOY_PHASES.indexOf(phase);

const shouldRunPhaseFrom = (startPhase: DeployPhase, phase: DeployPhase): boolean => {
  return phaseIndex(phase) >= phaseIndex(startPhase);
};

export const sanitizeDeployErrorMessage = (message: string): string => {
  const redacted = message
    .replace(/0x[a-fA-F0-9]{64}/gu, '[redacted-hex-key]')
    .replace(
      /(mpp_private_key|api[_-]?key|token|secret|password|credential|access[_-]?token|auth[_-]?token)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu,
      '$1=[redacted]',
    );
  return truncateOneLine(redacted, 420);
};

export const toDeployCliError = (error: unknown): Error => {
  const message = sanitizeDeployErrorMessage(
    error instanceof Error ? error.message : String(error),
  );
  return new Error(message);
};

export const isDropletAlreadyDeletedError = (error: unknown): boolean => {
  return error instanceof MppDoError && error.kind === 'not_found';
};

const assertSingleLineValue = (label: string, value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Invalid ${label}: value cannot be empty`);
  }
  if (trimmed.includes('\n') || trimmed.includes('\r') || trimmed.includes('\0')) {
    throw new Error(`Invalid ${label}: value must be a single line`);
  }
  return trimmed;
};

export const normalizeDropletName = (value: string): string => {
  let normalized = assertSingleLineValue('droplet name', value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (normalized.length > 63) {
    normalized = normalized.slice(0, 63).replace(/-+$/u, '');
  }
  if (!normalized) {
    throw new Error('Invalid droplet name: value cannot be empty after normalization');
  }
  if (!DROPLET_NAME_PATTERN.test(normalized)) {
    throw new Error(
      'Invalid droplet name: use lowercase letters, numbers, or hyphens (1-63 chars, no trailing hyphen)',
    );
  }
  return normalized;
};

const hasSignalRuntimeConfig = async (envPath: string): Promise<boolean> => {
  if (!(await fileExists(envPath))) return false;
  const content = await readFile(envPath, 'utf8');
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsAt = trimmed.indexOf('=');
    if (equalsAt <= 0) continue;
    const key = trimmed.slice(0, equalsAt).trim();
    const value = trimmed.slice(equalsAt + 1).trim();
    if (
      (key === 'SIGNAL_DAEMON_URL' ||
        key === 'SIGNAL_HTTP_URL' ||
        key === 'SIGNAL_API_URL' ||
        key === 'SIGNAL_NUMBER') &&
      value !== '' &&
      value !== '""' &&
      value !== "''"
    ) {
      return true;
    }
  }
  return false;
};

const buildComposeYaml = (runtimeImageTag: string, includeSignalApi: boolean): string => {
  const lines = [
    'services:',
    '  homie:',
    `    image: ${runtimeImageTag}`,
    '    restart: unless-stopped',
    '    env_file: .env',
    '    environment:',
    '      HOMIE_CONFIG_PATH: /app/homie.toml',
    '    volumes:',
    '      - ./homie.toml:/app/homie.toml:ro',
    '      - ./identity:/app/identity:ro',
    '      - ./data:/app/data:rw',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:9091/health >/dev/null 2>&1 || exit 1"]',
    '      interval: 30s',
    '      timeout: 5s',
    '      retries: 3',
    '      start_period: 15s',
    '',
  ];
  if (includeSignalApi) {
    lines.push(
      '  signal-api:',
      '    image: bbernhard/signal-cli-rest-api:latest',
      '    environment:',
      '      MODE: json-rpc',
      '    volumes:',
      '      - ./signal-data:/home/.local/share/signal-cli:rw',
      '    restart: unless-stopped',
      '    profiles:',
      '      - signal',
      '',
    );
  }
  return lines.join('\n');
};

const ensureFundingGate = async (input: {
  reporter: DeployReporter;
  env: DeployEnv;
  modelFast: string;
  baseUrl: string;
  interactive: boolean;
}): Promise<void> => {
  const address = deriveMppWalletAddress(input.env.MPP_PRIVATE_KEY) ?? 'unknown';
  input.reporter.info(`wallet address: ${address}`);
  if (address !== 'unknown') {
    input.reporter.info('scan QR to fund this wallet');
    try {
      qrcode.generate(`ethereum:${address}`, { small: true });
    } catch (err) {
      // Some terminals do not support QR glyphs.
      input.reporter.detail(
        `qr render unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (;;) {
    const runAt = input.reporter.run('checking wallet readiness');
    try {
      await verifyMppModelAccess({
        env: input.env,
        model: input.modelFast,
        baseUrl: input.baseUrl,
        timeoutMs: 12_000,
      });
      input.reporter.ok('wallet funded and verified', runAt);
      return;
    } catch (err) {
      if (!input.interactive) throw err;
      input.reporter.fail(
        err instanceof MppVerifyError
          ? `wallet not ready [${err.failure.code}] ${err.failure.detail}`
          : `wallet not ready: ${err instanceof Error ? err.message : String(err)}`,
      );
      const action = await p.select({
        message: 'Funding gate',
        options: [
          { value: 'check', label: 'Check again' },
          { value: 'docs', label: 'Open MPP docs' },
          { value: 'exit', label: 'Exit deploy' },
        ],
        initialValue: 'check',
      });
      if (p.isCancel(action) || action === 'exit') {
        throw new Error(
          'Deploy stopped in funding gate. Fund wallet, then run `homie deploy resume`.',
        );
      }
      if (action === 'docs') {
        const opened = await openUrl(MPP_DOCS_URL);
        if (!opened) input.reporter.warn(`could not open browser automatically (${MPP_DOCS_URL})`);
      }
    }
  }
};

const promptTextWithDefault = async (message: string, initialValue: string): Promise<string> => {
  const value = await p.text({ message, initialValue });
  if (p.isCancel(value)) return initialValue;
  const normalized = String(value).trim();
  return normalized || initialValue;
};

const copyRuntimeBundle = async (input: {
  reporter: DeployReporter;
  host: string;
  privateKeyPath: string;
  hostKeyPins?: readonly string[] | undefined;
  configPath: string;
  projectDir: string;
  identityDir: string;
  dataDir: string;
  runtimeImageTag: string;
}): Promise<boolean> => {
  const envPath = path.join(input.projectDir, '.env');
  const composePath = path.join(os.tmpdir(), `homie-compose-${Date.now().toString(36)}.yml`);
  const includeSignalApi = await hasSignalRuntimeConfig(envPath);
  await writeFile(
    composePath,
    `${buildComposeYaml(input.runtimeImageTag, includeSignalApi)}\n`,
    'utf8',
  );
  const ensureRemote = input.reporter.run('preparing remote runtime directories');
  const runtimeDirQ = shellQuote(REMOTE_RUNTIME_DIR);
  const runtimeUserQ = shellQuote(REMOTE_RUNTIME_USER);
  const mkdirResult = await sshExec({
    host: input.host,
    user: REMOTE_RUNTIME_USER,
    privateKeyPath: input.privateKeyPath,
    expectedHostKeyPins: input.hostKeyPins,
    command: [
      `sudo mkdir -p ${runtimeDirQ}/identity ${runtimeDirQ}/data ${runtimeDirQ}/signal-data`,
      `sudo chown -R ${runtimeUserQ}:${runtimeUserQ} ${runtimeDirQ}`,
    ].join(' && '),
  });
  if (mkdirResult.code !== 0) {
    throw new Error(`remote directory prep failed: ${mkdirResult.stderr || mkdirResult.stdout}`);
  }
  input.reporter.ok('remote runtime directories ready', ensureRemote);

  const copyConfig = input.reporter.run('transferring homie.toml and .env');
  if (!(await fileExists(envPath))) {
    await writeFile(envPath, '', 'utf8');
    input.reporter.warn(`.env missing; created empty ${envPath}`);
  }
  for (const pair of [
    { localPath: input.configPath, remotePath: `${REMOTE_RUNTIME_DIR}/homie.toml` },
    { localPath: envPath, remotePath: `${REMOTE_RUNTIME_DIR}/.env` },
    { localPath: composePath, remotePath: `${REMOTE_RUNTIME_DIR}/compose.yml` },
  ]) {
    const copied = await scpCopy({
      host: input.host,
      user: REMOTE_RUNTIME_USER,
      privateKeyPath: input.privateKeyPath,
      expectedHostKeyPins: input.hostKeyPins,
      localPath: pair.localPath,
      remotePath: pair.remotePath,
    });
    if (copied.code !== 0) {
      throw new Error(
        `file transfer failed (${pair.localPath}): ${copied.stderr || copied.stdout}`,
      );
    }
  }
  input.reporter.ok('config bundle transferred', copyConfig);
  if (includeSignalApi) {
    input.reporter.detail('signal sidecar enabled from env config');
  } else {
    input.reporter.detail('signal sidecar disabled (no signal env settings found)');
  }

  if (await fileExists(input.identityDir)) {
    const copyIdentity = input.reporter.run('transferring identity directory');
    const identityCopy = await scpCopy({
      host: input.host,
      user: REMOTE_RUNTIME_USER,
      privateKeyPath: input.privateKeyPath,
      expectedHostKeyPins: input.hostKeyPins,
      localPath: input.identityDir,
      remotePath: REMOTE_RUNTIME_DIR,
      recursive: true,
    });
    if (identityCopy.code !== 0) {
      throw new Error(`identity transfer failed: ${identityCopy.stderr || identityCopy.stdout}`);
    }
    input.reporter.ok('identity directory transferred', copyIdentity);
  } else {
    input.reporter.warn('identity directory missing locally; remote deploy continues without it');
  }

  if (await fileExists(input.dataDir)) {
    const dataEntries = (await readdir(input.dataDir, { withFileTypes: true })).filter(
      (entry) => entry.name !== 'deploy-keys',
    );
    if (dataEntries.length === 0) {
      input.reporter.detail('data directory empty; skipping data sync');
    } else {
      const copyData = input.reporter.run('transferring data directory');
      for (const entry of dataEntries) {
        const localPath = path.join(input.dataDir, entry.name);
        const dataCopy = await scpCopy({
          host: input.host,
          user: REMOTE_RUNTIME_USER,
          privateKeyPath: input.privateKeyPath,
          expectedHostKeyPins: input.hostKeyPins,
          localPath,
          remotePath: `${REMOTE_RUNTIME_DIR}/data`,
          recursive: entry.isDirectory(),
        });
        if (dataCopy.code !== 0) {
          throw new Error(
            `data transfer failed (${entry.name}): ${dataCopy.stderr || dataCopy.stdout}`,
          );
        }
      }
      input.reporter.ok('data directory transferred', copyData);
    }
  } else {
    await mkdir(input.dataDir, { recursive: true });
  }
  return includeSignalApi;
};

const runRemoteCompose = async (input: {
  reporter: DeployReporter;
  host: string;
  privateKeyPath: string;
  hostKeyPins?: readonly string[] | undefined;
  runtimeRepo: string;
  runtimeRef: string;
  runtimeImageTag: string;
  includeSignalApi: boolean;
}): Promise<void> => {
  const buildAt = input.reporter.run('building runtime image on droplet');
  const buildResult = await sshExec({
    host: input.host,
    user: REMOTE_RUNTIME_USER,
    privateKeyPath: input.privateKeyPath,
    expectedHostKeyPins: input.hostKeyPins,
    command: [
      `cd ${REMOTE_RUNTIME_DIR}`,
      `rm -rf ${REMOTE_RUNTIME_SOURCE_DIR}`,
      `git clone --depth 1 --branch ${shellQuote(input.runtimeRef)} ${shellQuote(input.runtimeRepo)} ${shellQuote(REMOTE_RUNTIME_SOURCE_DIR)}`,
      `cd ${REMOTE_RUNTIME_SOURCE_DIR}`,
      `docker build -t ${shellQuote(input.runtimeImageTag)} .`,
    ].join(' && '),
    timeoutMs: 900_000,
  });
  if (buildResult.code !== 0) {
    throw new Error(`runtime image build failed: ${buildResult.stderr || buildResult.stdout}`);
  }
  input.reporter.ok('runtime image built', buildAt);

  const startAt = input.reporter.run('starting docker compose runtime');
  const composeUpCommand = input.includeSignalApi
    ? '(COMPOSE_PROFILES=signal docker compose -f compose.yml up -d || COMPOSE_PROFILES=signal docker-compose -f compose.yml up -d)'
    : '(docker compose -f compose.yml up -d || docker-compose -f compose.yml up -d)';
  const result = await sshExec({
    host: input.host,
    user: REMOTE_RUNTIME_USER,
    privateKeyPath: input.privateKeyPath,
    expectedHostKeyPins: input.hostKeyPins,
    command: `cd ${REMOTE_RUNTIME_DIR} && ${composeUpCommand}`,
    timeoutMs: 180_000,
  });
  if (result.code !== 0) {
    throw new Error(`docker compose start failed: ${result.stderr || result.stdout}`);
  }
  input.reporter.ok('runtime started', startAt);
};

const ensureRemoteDockerRuntime = async (input: {
  reporter: DeployReporter;
  host: string;
  privateKeyPath: string;
  hostKeyPins?: readonly string[] | undefined;
}): Promise<void> => {
  const startAt = input.reporter.run('ensuring docker runtime availability');
  const result = await sshExec({
    host: input.host,
    user: REMOTE_RUNTIME_USER,
    privateKeyPath: input.privateKeyPath,
    expectedHostKeyPins: input.hostKeyPins,
    command: [
      // Wait for cloud-init first to avoid racing apt/docker installation on fresh droplets.
      'if command -v cloud-init >/dev/null 2>&1; then sudo cloud-init status --wait >/dev/null 2>&1 || true; fi',
      'if command -v docker >/dev/null 2>&1 && (docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1); then docker --version && exit 0; fi',
      'export DEBIAN_FRONTEND=noninteractive',
      'sudo apt-get update -y >/dev/null',
      '(sudo apt-get install -y docker.io git >/dev/null || true)',
      '(sudo apt-get install -y docker-compose-plugin >/dev/null || sudo apt-get install -y docker-compose-v2 >/dev/null || sudo apt-get install -y docker-compose >/dev/null)',
      'sudo systemctl enable --now docker >/dev/null 2>&1 || true',
      `sudo usermod -aG docker ${REMOTE_RUNTIME_USER} >/dev/null 2>&1 || true`,
      '(docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1)',
    ].join(' && '),
    timeoutMs: 300_000,
  });
  if (result.code !== 0) {
    throw new Error(`docker runtime unavailable: ${result.stderr || result.stdout}`);
  }
  input.reporter.ok('docker runtime ready', startAt);
};

const verifyRemoteHealth = async (input: {
  reporter: DeployReporter;
  host: string;
  privateKeyPath: string;
  hostKeyPins?: readonly string[] | undefined;
}): Promise<void> => {
  const startAt = input.reporter.run('checking service health');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await sshExec({
      host: input.host,
      user: REMOTE_RUNTIME_USER,
      privateKeyPath: input.privateKeyPath,
      expectedHostKeyPins: input.hostKeyPins,
      command:
        "cd /opt/homie && (wget -qO- 'http://127.0.0.1:9091/health' || curl -fsS 'http://127.0.0.1:9091/health')",
      timeoutMs: 8_000,
    });
    if (result.code === 0 && result.stdout.includes('"status"')) {
      input.reporter.ok('service healthy', startAt);
      return;
    }
    await sleep(2_000);
  }
  throw new Error('health check failed: service did not become healthy in time');
};

const runDeployStatus = async (input: {
  reporter: DeployReporter;
  statePath: string;
  client: MppDoClient;
  json: boolean;
}): Promise<void> => {
  const state = await loadDeployState(input.statePath);
  if (!state) {
    throw new Error(`No deploy state found at ${input.statePath}. Run \`homie deploy\` first.`);
  }
  if (!state.droplet?.id) {
    throw new Error(`Deploy state exists but no droplet id is recorded (${input.statePath}).`);
  }
  const droplet = await input.client.getDroplet(state.droplet.id);
  const ip = MppDoClient.dropletPublicIpv4(droplet);
  if (input.json) {
    input.reporter.emitResult({
      result: 'ok',
      statePath: input.statePath,
      droplet: {
        id: droplet.id,
        name: droplet.name,
        status: droplet.status,
        ip,
      },
    });
    return;
  }
  input.reporter.phase('Status');
  input.reporter.ok(`droplet id: ${String(droplet.id)}`);
  input.reporter.ok(`droplet name: ${droplet.name}`);
  input.reporter.ok(`droplet status: ${droplet.status}`);
  input.reporter.ok(`droplet ip: ${ip ?? 'pending'}`);
  input.reporter.info(`state: ${input.statePath}`);
  input.reporter.phaseDone('Status');
};

const runDeployDestroy = async (input: {
  reporter: DeployReporter;
  statePath: string;
  client: MppDoClient;
  interactive: boolean;
}): Promise<void> => {
  const state = await loadDeployState(input.statePath);
  if (!state) {
    throw new Error(`No deploy state found at ${input.statePath}. Nothing to destroy.`);
  }
  if (input.interactive) {
    const confirmed = await p.confirm({
      message: `Destroy droplet${state.droplet?.id ? ` ${String(state.droplet.id)}` : ''}?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      throw new Error('Destroy cancelled.');
    }
  }

  input.reporter.phase('Destroy');
  if (state.droplet?.id) {
    const deleting = input.reporter.run(`deleting droplet ${String(state.droplet.id)}`);
    try {
      await input.client.deleteDroplet(state.droplet.id);
      input.reporter.ok(`droplet ${String(state.droplet.id)} deleted`, deleting);
    } catch (err) {
      if (isDropletAlreadyDeletedError(err)) {
        input.reporter.warn(
          `droplet ${String(state.droplet.id)} already deleted or missing; continuing cleanup`,
        );
      } else {
        throw err;
      }
    }
  }
  if (state.ssh?.keyId && state.ssh.managedByDeploy) {
    const deletingKey = input.reporter.run(`deleting account ssh key ${String(state.ssh.keyId)}`);
    try {
      await input.client.deleteSshKey(state.ssh.keyId);
      input.reporter.ok(`ssh key ${String(state.ssh.keyId)} deleted`, deletingKey);
    } catch (err) {
      input.reporter.warn(
        `ssh key cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (state.ssh?.keyId) {
    input.reporter.info(
      `skipping ssh key deletion for shared key ${String(state.ssh.keyId)} (not managed by this deployment)`,
    );
  }
  await clearDeployState(input.statePath);
  input.reporter.ok(`state cleared (${input.statePath})`);
  input.reporter.phaseDone('Destroy');
};

const runDeploySsh = async (input: {
  reporter: DeployReporter;
  statePath: string;
}): Promise<void> => {
  let state = await loadDeployState(input.statePath);
  if (!state) {
    throw new Error(`No deploy state found at ${input.statePath}. Run \`homie deploy\` first.`);
  }
  const host = state.droplet?.ip;
  const privateKeyPath = state.ssh?.privateKeyPath;
  if (!host || !privateKeyPath) {
    throw new Error('Deploy state is missing host/private key information for SSH.');
  }
  let hostKeyPins = state.ssh?.hostKeyPins;
  if (!hostKeyPins || hostKeyPins.length === 0) {
    input.reporter.warn('deploy state missing ssh host key pin; capturing from current host');
    const ready = await waitForSshReady({
      host,
      user: REMOTE_RUNTIME_USER,
      privateKeyPath,
      timeoutMs: 30_000,
      intervalMs: 1_500,
    });
    hostKeyPins = [...ready.hostKeyPins];
    if (!state.ssh) {
      throw new Error('Deploy state is missing SSH key metadata; cannot persist host key pin');
    }
    state = {
      ...state,
      ssh: {
        ...state.ssh,
        hostKeyPins,
      },
    };
    await saveDeployState(state);
  }

  input.reporter.info(`opening ssh session to ${REMOTE_RUNTIME_USER}@${host}`);
  const code = await openInteractiveSsh({
    host,
    user: REMOTE_RUNTIME_USER,
    privateKeyPath,
    expectedHostKeyPins: hostKeyPins,
  });
  if (code !== 0) {
    throw new Error(`SSH session exited with code ${String(code)}`);
  }
};

export async function runDeployCommand(
  opts: GlobalOpts,
  cmdArgs: readonly string[],
  loadCfg: () => Promise<LoadedHomieConfig>,
): Promise<void> {
  const parsed = parseDeployArgs(cmdArgs);
  const loaded = await loadCfg();
  const runtimeEnv = process.env as DeployEnv;
  const maxDeposit = resolveMppMaxDeposit(runtimeEnv.MPP_MAX_DEPOSIT, DEFAULT_DEPLOY_MAX_DEPOSIT);
  const rpcUrl = resolveMppRpcUrl(runtimeEnv);
  const runtimeRepo = assertSingleLineValue(
    'HOMIE_DEPLOY_REPO',
    runtimeEnv.HOMIE_DEPLOY_REPO?.trim() || DEFAULT_RUNTIME_REPO,
  );
  const runtimeRef = assertSingleLineValue(
    'HOMIE_DEPLOY_REF',
    runtimeEnv.HOMIE_DEPLOY_REF?.trim() || DEFAULT_RUNTIME_REF,
  );
  const runtimeImageTag = assertSingleLineValue('runtime image tag', DEFAULT_RUNTIME_IMAGE_TAG);
  const deployMaxPerRequestUsd = resolvePositiveUsdLimit(
    runtimeEnv.HOMIE_DEPLOY_MAX_PER_REQUEST_USD,
    DEFAULT_DEPLOY_MAX_PER_REQUEST_USD,
    'HOMIE_DEPLOY_MAX_PER_REQUEST_USD',
  );
  const deployMaxPerDayUsd = resolvePositiveUsdLimit(
    runtimeEnv.HOMIE_DEPLOY_MAX_PER_DAY_USD,
    DEFAULT_DEPLOY_MAX_PER_DAY_USD,
    'HOMIE_DEPLOY_MAX_PER_DAY_USD',
  );
  const env: DeployEnv = {
    ...runtimeEnv,
    MPP_MAX_DEPOSIT: maxDeposit,
  };
  const outputMode = resolveDeployOutputMode({
    json: opts.json,
    verbose: opts.verbose,
    quiet: opts.quiet,
  });
  const reporter = new DeployReporter({
    mode: outputMode,
    useColor: shouldUseColor(opts),
    useUnicode: shouldUseUnicode(),
  });
  const statePath = defaultDeployStatePath(loaded.config.paths.dataDir);
  const rootBaseUrl =
    loaded.config.model.provider.kind === 'mpp'
      ? (loaded.config.model.provider.baseUrl ?? 'https://mpp.tempo.xyz')
      : 'https://mpp.tempo.xyz';

  reporter.beginSession('homie deploy', 'Fund once. We automate everything else.');

  if (parsed.action === 'ssh') {
    await runDeploySsh({ reporter, statePath });
    return;
  }

  const wallet = requireMppWallet(env);
  const paymentClient = createPaymentSessionClient({
    wallet,
    policy: createDefaultSpendPolicy({
      maxPerRequestUsd: deployMaxPerRequestUsd,
      maxPerDayUsd: deployMaxPerDayUsd,
    }),
    maxDeposit,
    rpcUrl,
  });
  const mppDo = new MppDoClient({
    rootBaseUrl,
    fetchImpl: paymentClient.fetch,
    retryCount: 2,
  });

  if (parsed.action === 'status') {
    await runDeployStatus({ reporter, statePath, client: mppDo, json: opts.json });
    return;
  }
  if (parsed.action === 'destroy') {
    await runDeployDestroy({ reporter, statePath, client: mppDo, interactive: opts.interactive });
    return;
  }
  let state: DeployState;
  if (parsed.action === 'resume') {
    const existing = await loadDeployState(statePath);
    if (!existing)
      throw new Error(`No deploy state found at ${statePath}. Run \`homie deploy\` first.`);
    state = existing;
  } else {
    state = createInitialDeployState({
      projectDir: loaded.config.paths.projectDir,
      configPath: loaded.configPath,
      statePath,
    });
    await saveDeployState(state);
  }
  const startPhase: DeployPhase = parsed.action === 'resume' ? state.phase : 'validate';
  if (parsed.action === 'resume') {
    reporter.info(`resuming deploy from phase: ${startPhase}`);
  }
  if (parsed.action === 'resume' && startPhase === 'done') {
    reporter.summary([
      `deploy already complete`,
      `droplet: ${String(state.droplet?.id ?? 'unknown')}`,
      `ip: ${state.droplet?.ip ?? 'unknown'}`,
      `state: ${statePath}`,
      'next: homie deploy status | homie deploy ssh | homie deploy destroy',
    ]);
    reporter.emitResult({
      result: 'ok',
      dropletId: state.droplet?.id,
      ip: state.droplet?.ip,
      statePath,
      resumed: true,
    });
    return;
  }
  let activeHost = state.droplet?.ip;
  let activePrivateKeyPath = state.ssh?.privateKeyPath;
  let activeHostKeyPins = state.ssh?.hostKeyPins;

  try {
    if (shouldRunPhaseFrom(startPhase, 'validate')) {
      reporter.phase('Validate');
      if (loaded.config.model.provider.kind !== 'mpp') {
        reporter.warn(
          'model provider is not set to mpp; deploy still uses MPP wallet for infrastructure calls',
        );
      }
      reporter.ok(`config loaded (${loaded.configPath})`);
      reporter.ok(`wallet detected (${wallet.address.slice(0, 8)}...${wallet.address.slice(-4)})`);
      reporter.detail(`mpp max deposit: ${maxDeposit}`);
      if (rpcUrl) reporter.detail('mpp rpc: configured');
      reporter.detail(`runtime source: ${runtimeRepo}#${runtimeRef}`);
      reporter.detail(`runtime image tag: ${runtimeImageTag}`);
      reporter.detail(
        `deploy spend policy: max/request $${deployMaxPerRequestUsd} · max/day $${deployMaxPerDayUsd}`,
      );
      reporter.ok(`state path ready (${statePath})`);
      reporter.phaseDone('Validate');
      state = { ...state, phase: 'funding_gate' };
      await saveDeployState(state);
    }

    if (shouldRunPhaseFrom(startPhase, 'funding_gate')) {
      reporter.phase('FundingGate');
      await ensureFundingGate({
        reporter,
        env,
        modelFast: loaded.config.model.models.fast,
        baseUrl: rootBaseUrl,
        interactive: opts.interactive && !opts.yes,
      });
      reporter.phaseDone('FundingGate');
      state = {
        ...state,
        phase: 'provision',
        payment: {
          walletAddress: wallet.address,
          rootBaseUrl,
          provider: loaded.config.model.provider.kind,
        },
      };
      await saveDeployState(state);
    }

    if (shouldRunPhaseFrom(startPhase, 'provision')) {
      reporter.phase('Provision');
      const allRegions = await mppDo.listRegions();
      const allSizes = await mppDo.listSizes();
      const allImages = await mppDo.listImages({ perPage: 200 });
      const preferredRegion = parsed.region || env.HOMIE_DEPLOY_REGION || DEFAULT_REGION;
      const preferredSize = parsed.size || env.HOMIE_DEPLOY_SIZE || DEFAULT_SIZE;
      const preferredImage = parsed.image || env.HOMIE_DEPLOY_IMAGE || DEFAULT_DROPLET_IMAGE;
      const projectSlug = path
        .basename(loaded.config.paths.projectDir)
        .replace(/[^a-z0-9-]/giu, '-');
      const normalizedProjectSlug = projectSlug || 'project';
      const defaultName = `homie-${normalizedProjectSlug}`.slice(0, 54);

      const region =
        opts.interactive && !opts.yes
          ? await promptTextWithDefault('DigitalOcean region slug', preferredRegion)
          : preferredRegion;
      const size =
        opts.interactive && !opts.yes
          ? await promptTextWithDefault('Droplet size slug', preferredSize)
          : preferredSize;
      const image = preferredImage;
      const generatedName = `${defaultName}-${Date.now().toString(36).slice(-6)}`.slice(0, 63);
      const name = normalizeDropletName(
        state.droplet?.name ?? parsed.name ?? (generatedName || 'homie-vps'),
      );

      reporter.detail(`regions available: ${String(allRegions.length)}`);
      reporter.detail(`sizes available: ${String(allSizes.length)}`);
      reporter.detail(`images available: ${String(allImages.length)}`);
      reporter.ok(`selected region (${region})`);
      reporter.ok(`selected size (${size})`);
      reporter.ok(`selected image (${image})`);

      if (parsed.dryRun) {
        reporter.warn('dry-run enabled; skipping droplet creation and provisioning');
        reporter.phaseDone('Provision');
        reporter.summary([
          `state: ${statePath}`,
          `planned name: ${name}`,
          `planned region/size/image: ${region} / ${size} / ${image}`,
          'next: run homie deploy (without --dry-run)',
        ]);
        reporter.emitResult({
          result: 'dry_run',
          statePath,
          plan: { name, region, size, image },
        });
        return;
      }

      const keysDir = path.join(os.homedir(), '.homie', 'deploy-keys', normalizedProjectSlug);
      const keyPair = await generateSshKeyPair(keysDir, 'id_ed25519_homie');
      activePrivateKeyPath = keyPair.privateKeyPath;
      let keyId = state.ssh?.keyId;
      let keyName = state.ssh?.keyName;
      let keyFingerprint = state.ssh?.fingerprint;
      let keyManagedByDeploy = state.ssh?.managedByDeploy ?? false;
      if (!keyId) {
        const createKeyAt = reporter.run('creating ssh key in DigitalOcean account');
        try {
          const accountKey = await mppDo.createSshKey(
            `homie-${Date.now().toString(36).slice(-8)}`,
            keyPair.publicKey,
          );
          keyId = accountKey.id;
          keyName = accountKey.name;
          keyFingerprint = accountKey.fingerprint;
          keyManagedByDeploy = true;
          reporter.ok(`ssh key created (id: ${String(accountKey.id)})`, createKeyAt);
        } catch (err) {
          if (
            err instanceof MppDoError &&
            err.kind === 'invalid_request' &&
            err.detail.toLowerCase().includes('already in use')
          ) {
            const existing = await mppDo.listSshKeys();
            const matched = existing.find((item) => item.public_key?.trim() === keyPair.publicKey);
            if (!matched) throw err;
            keyId = matched.id;
            keyName = matched.name;
            keyFingerprint = matched.fingerprint;
            keyManagedByDeploy = false;
            reporter.warn(
              `ssh key already exists; reusing key id ${String(matched.id)} (${matched.fingerprint})`,
            );
          } else {
            throw err;
          }
        }
      } else {
        reporter.ok(`reusing existing ssh key id ${String(keyId)}`);
      }

      let createRegion = state.droplet?.region ?? region;
      let ready:
        | {
            id: number;
            ip: string;
            status: string;
          }
        | undefined;
      if (state.droplet?.id) {
        const recoverAt = reporter.run(
          `checking existing droplet ${String(state.droplet.id)} from deploy state`,
        );
        try {
          ready = await pollDropletReady(mppDo, state.droplet.id);
          reporter.ok(`reusing droplet ${String(ready.id)} (ip: ${ready.ip})`, recoverAt);
        } catch (err) {
          if (err instanceof MppDoError && err.kind === 'not_found') {
            reporter.warn(
              `droplet ${String(state.droplet.id)} no longer exists; creating a new one`,
            );
          } else {
            throw err;
          }
        }
      }

      if (!ready) {
        const userData = buildCloudInitUserData({
          authorizedSshPublicKeys: [keyPair.publicKey],
          runtimeDir: REMOTE_RUNTIME_DIR,
          runtimeUser: REMOTE_RUNTIME_USER,
        });

        const regionCandidates = [
          region,
          ...(parsed.region || env.HOMIE_DEPLOY_REGION
            ? []
            : allRegions
                .filter((candidate) => candidate.available && candidate.slug !== region)
                .map((r) => r.slug)),
        ];
        let created: Awaited<ReturnType<typeof mppDo.createDroplet>> | undefined;
        for (let i = 0; i < regionCandidates.length; i += 1) {
          const candidateRegion = regionCandidates[i] ?? region;
          const isFallbackAttempt = i > 0;
          const createDropletAt = reporter.run(
            isFallbackAttempt
              ? `creating droplet via MPP DigitalOcean (fallback region: ${candidateRegion})`
              : 'creating droplet via MPP DigitalOcean',
          );
          try {
            const result = await mppDo.createDroplet({
              name,
              region: candidateRegion,
              size,
              image,
              sshKeyIds: [keyId],
              userData,
              tags: ['homie', 'mpp'],
              enableBackups: false,
              enableMonitoring: true,
            });
            createRegion = candidateRegion;
            created = result;
            reporter.ok(`droplet created (id: ${String(result.id)})`, createDropletAt);
            break;
          } catch (err) {
            if (
              !isRegionCapacityError(err) ||
              i === regionCandidates.length - 1 ||
              !regionCandidates[i + 1]
            ) {
              throw err;
            }
            reporter.warn(
              `region ${candidateRegion} unavailable (${err instanceof Error ? err.message : String(err)}); trying ${regionCandidates[i + 1]}`,
            );
          }
        }
        if (!created) {
          throw new Error('failed to create droplet after region fallback attempts');
        }
        const waitDropletAt = reporter.run('waiting for droplet network readiness');
        ready = await pollDropletReady(mppDo, created.id);
        if (createRegion !== region) {
          reporter.warn(`using fallback region ${createRegion} (requested ${region})`);
        }
        reporter.ok(`droplet active (ip: ${ready.ip})`, waitDropletAt);
      }
      activeHost = ready.ip;
      reporter.phaseDone('Provision');

      state = {
        ...state,
        phase: 'bootstrap',
        ssh: {
          privateKeyPath: keyPair.privateKeyPath,
          publicKeyPath: keyPair.publicKeyPath,
          keyId,
          keyName,
          fingerprint: keyFingerprint,
          managedByDeploy: keyManagedByDeploy,
          hostKeyPins: activeHostKeyPins,
        },
        droplet: {
          id: ready.id,
          name,
          region: createRegion,
          size,
          image,
          ip: ready.ip,
          status: ready.status,
        },
      };
      await saveDeployState(state);
    }

    const ensureActiveHost = async (): Promise<string> => {
      if (activeHost) return activeHost;
      const dropletId = state.droplet?.id;
      if (!dropletId) {
        throw new Error('Deploy state is missing droplet id; run `homie deploy` to reprovision.');
      }
      const recoverAt = reporter.run(`recovering network details for droplet ${String(dropletId)}`);
      const ready = await pollDropletReady(mppDo, dropletId);
      activeHost = ready.ip;
      state = {
        ...state,
        droplet: {
          id: ready.id,
          name: state.droplet?.name ?? `homie-${String(ready.id)}`,
          region: state.droplet?.region,
          size: state.droplet?.size,
          image: state.droplet?.image,
          ip: ready.ip,
          status: ready.status,
        },
      };
      await saveDeployState(state);
      reporter.ok(`droplet network ready (ip: ${ready.ip})`, recoverAt);
      return activeHost;
    };

    const requirePrivateKeyPath = (): string => {
      const privateKeyPath = activePrivateKeyPath ?? state.ssh?.privateKeyPath;
      if (!privateKeyPath) {
        throw new Error(
          'Deploy state is missing SSH private key path; run `homie deploy destroy` then `homie deploy`.',
        );
      }
      activePrivateKeyPath = privateKeyPath;
      return privateKeyPath;
    };

    const ensureHostKeyPins = async (): Promise<readonly string[]> => {
      if (activeHostKeyPins && activeHostKeyPins.length > 0) return activeHostKeyPins;
      const host = await ensureActiveHost();
      const privateKeyPath = requirePrivateKeyPath();
      const pinAt = reporter.run('capturing ssh host key pin');
      const ready = await waitForSshReady({
        host,
        user: REMOTE_RUNTIME_USER,
        privateKeyPath,
        timeoutMs: 45_000,
        intervalMs: 1_500,
      });
      activeHostKeyPins = [...ready.hostKeyPins];
      if (!state.ssh) {
        throw new Error('Deploy state is missing SSH key metadata; cannot persist host key pin');
      }
      state = {
        ...state,
        ssh: {
          ...state.ssh,
          hostKeyPins: activeHostKeyPins,
        },
      };
      await saveDeployState(state);
      reporter.ok('ssh host key pin captured', pinAt);
      return activeHostKeyPins;
    };

    if (shouldRunPhaseFrom(startPhase, 'bootstrap')) {
      const host = await ensureActiveHost();
      const privateKeyPath = requirePrivateKeyPath();
      reporter.phase('Bootstrap');
      const sshReadyAt = reporter.run('waiting for ssh readiness');
      const sshReady = await waitForSshReady({
        host,
        user: REMOTE_RUNTIME_USER,
        privateKeyPath,
        expectedHostKeyPins: activeHostKeyPins,
        timeoutMs: 180_000,
        intervalMs: 2_000,
      });
      activeHostKeyPins = [...sshReady.hostKeyPins];
      reporter.ok('ssh ready', sshReadyAt);
      await ensureRemoteDockerRuntime({
        reporter,
        host,
        privateKeyPath,
        hostKeyPins: activeHostKeyPins,
      });
      const bootstrapAt = reporter.run('bootstrapping host runtime path');
      const runtimeDirQ = shellQuote(REMOTE_RUNTIME_DIR);
      const runtimeUserQ = shellQuote(REMOTE_RUNTIME_USER);
      const bootstrapResult = await sshExec({
        host,
        user: REMOTE_RUNTIME_USER,
        privateKeyPath,
        expectedHostKeyPins: activeHostKeyPins,
        command: [
          `sudo mkdir -p ${runtimeDirQ}/identity ${runtimeDirQ}/data ${runtimeDirQ}/signal-data`,
          `sudo chown -R ${runtimeUserQ}:${runtimeUserQ} ${runtimeDirQ}`,
        ].join(' && '),
        timeoutMs: 60_000,
      });
      if (bootstrapResult.code !== 0) {
        throw new Error(`bootstrap failed: ${bootstrapResult.stderr || bootstrapResult.stdout}`);
      }
      reporter.ok('host bootstrap complete', bootstrapAt);
      reporter.phaseDone('Bootstrap');

      state = {
        ...state,
        phase: 'deploy_runtime',
        ...(state.ssh
          ? {
              ssh: {
                ...state.ssh,
                hostKeyPins: activeHostKeyPins,
              },
            }
          : {}),
      };
      await saveDeployState(state);
    }

    if (shouldRunPhaseFrom(startPhase, 'deploy_runtime')) {
      const host = await ensureActiveHost();
      const privateKeyPath = requirePrivateKeyPath();
      const hostKeyPins = await ensureHostKeyPins();
      reporter.phase('DeployRuntime');
      const includeSignalApi = await copyRuntimeBundle({
        reporter,
        host,
        privateKeyPath,
        hostKeyPins,
        configPath: loaded.configPath,
        projectDir: loaded.config.paths.projectDir,
        identityDir: loaded.config.paths.identityDir,
        dataDir: loaded.config.paths.dataDir,
        runtimeImageTag,
      });
      await runRemoteCompose({
        reporter,
        host,
        privateKeyPath,
        hostKeyPins,
        runtimeRepo,
        runtimeRef,
        runtimeImageTag,
        includeSignalApi,
      });
      reporter.phaseDone('DeployRuntime');

      state = { ...state, phase: 'verify' };
      await saveDeployState(state);
    }

    if (shouldRunPhaseFrom(startPhase, 'verify')) {
      const host = await ensureActiveHost();
      const privateKeyPath = requirePrivateKeyPath();
      const hostKeyPins = await ensureHostKeyPins();
      reporter.phase('Verify');
      await verifyRemoteHealth({
        reporter,
        host,
        privateKeyPath,
        hostKeyPins,
      });
      reporter.phaseDone('Verify');

      state = { ...state, phase: 'done' };
      await saveDeployState(state);
    }

    reporter.summary([
      `deploy complete`,
      `droplet: ${String(state.droplet?.id ?? 'unknown')}`,
      `ip: ${state.droplet?.ip ?? activeHost ?? 'unknown'}`,
      `state: ${statePath}`,
      'next: homie deploy status | homie deploy ssh | homie deploy destroy',
    ]);
    reporter.emitResult({
      result: 'ok',
      dropletId: state.droplet?.id,
      ip: state.droplet?.ip ?? activeHost,
      statePath,
    });
  } catch (err) {
    const deployError = toDeployCliError(err);
    const message = deployError.message;
    try {
      await recordDeployError(statePath, message);
    } catch (recordErr) {
      const detail = recordErr instanceof Error ? recordErr.message : String(recordErr);
      reporter.warn(`could not persist deploy error state: ${detail}`);
    }
    reporter.fail(message);
    reporter.info(`resume: homie deploy resume`);
    reporter.info(`cleanup: homie deploy destroy`);
    if (err instanceof MppDoError && err.kind === 'insufficient_funds') {
      reporter.info('fund wallet, then run: homie deploy resume');
    }
    throw deployError;
  }
}
