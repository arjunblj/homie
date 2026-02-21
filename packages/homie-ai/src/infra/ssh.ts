import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileExists } from '../util/fs.js';

export interface RunCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnShellOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly stdin?: string | undefined;
}

const collectOutput = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) return '';
  const text = await new Response(stream).text();
  return text.trim();
};

const SSH_USER_PATTERN = /^[a-z_][a-z0-9._-]{0,31}$/iu;
const SSH_HOST_PATTERN = /^[A-Za-z0-9._:[\]-]+$/u;

const formatSshTarget = (user: string, host: string): string => {
  const normalizedUser = user.trim();
  const normalizedHost = host.trim();
  if (!SSH_USER_PATTERN.test(normalizedUser)) {
    throw new Error(`Invalid SSH user: "${user}"`);
  }
  if (!SSH_HOST_PATTERN.test(normalizedHost)) {
    throw new Error(`Invalid SSH host: "${host}"`);
  }
  return `${normalizedUser}@${normalizedHost}`;
};

const assertSafeRemoteCommand = (command: string): void => {
  const normalized = command.trim();
  if (!normalized) {
    throw new Error('SSH command cannot be empty');
  }
  if (normalized.includes('\n') || normalized.includes('\r') || normalized.includes('\0')) {
    throw new Error('SSH command must be a single line without control characters');
  }
};

const runCommand = async (
  cmd: readonly string[],
  options: SpawnShellOptions = {},
): Promise<RunCommandResult> => {
  if (cmd.length === 0) {
    throw new Error('runCommand requires at least one argument');
  }
  const spawnOptions: Bun.SpawnOptions.OptionsObject<'pipe', 'pipe', 'pipe'> & { cmd: string[] } = {
    cmd: [...cmd],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (options.cwd) spawnOptions.cwd = options.cwd;
  if (options.env) spawnOptions.env = options.env;
  if (options.timeoutMs) spawnOptions.timeout = options.timeoutMs;

  const proc = Bun.spawn(spawnOptions);
  const sink = proc.stdin;
  if (sink && typeof sink !== 'number') {
    if (options.stdin) {
      await sink.write(options.stdin);
    }
    await sink.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    collectOutput(proc.stdout),
    collectOutput(proc.stderr),
  ]);
  return {
    code: exitCode,
    stdout,
    stderr,
  };
};

export interface GenerateSshKeyPairResult {
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
  readonly publicKey: string;
}

export const generateSshKeyPair = async (
  keyDir: string,
  keyName: string,
): Promise<GenerateSshKeyPairResult> => {
  await mkdir(keyDir, { recursive: true });
  const privateKeyPath = path.join(keyDir, keyName);
  const publicKeyPath = `${privateKeyPath}.pub`;
  const alreadyExists = await fileExists(privateKeyPath);
  if (!alreadyExists) {
    const result = await runCommand(
      ['ssh-keygen', '-t', 'ed25519', '-N', '', '-f', privateKeyPath, '-C', 'homie-deploy'],
      {
        timeoutMs: 15_000,
      },
    );
    if (result.code !== 0) {
      throw new Error(`ssh-keygen failed: ${result.stderr || result.stdout || 'unknown error'}`);
    }
  }
  const publicKey = (await readFile(publicKeyPath, 'utf8')).trim();
  return { privateKeyPath, publicKeyPath, publicKey };
};

const sshBaseArgs = (
  privateKeyPath: string,
  knownHostsPath: string = path.join(path.dirname(privateKeyPath), 'known_hosts'),
): string[] => [
  '-i',
  privateKeyPath,
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=8',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  `UserKnownHostsFile=${knownHostsPath}`,
];

const knownHostsPathFor = (privateKeyPath: string): string =>
  path.join(path.dirname(privateKeyPath), 'known_hosts');

const ensureKnownHost = async (host: string, privateKeyPath: string): Promise<void> => {
  const knownHostsPath = knownHostsPathFor(privateKeyPath);
  await mkdir(path.dirname(knownHostsPath), { recursive: true });
  const existing = await readFile(knownHostsPath, 'utf8').catch(() => '');
  if (existing.includes(host)) return;
  const scan = await runCommand(['ssh-keyscan', '-T', '5', host], { timeoutMs: 8_000 });
  if (scan.code !== 0 || !scan.stdout.trim()) {
    throw new Error(
      `ssh-keyscan failed for ${host}: ${scan.stderr || scan.stdout || 'unknown error'}`,
    );
  }
  const line = scan.stdout.endsWith('\n') ? scan.stdout : `${scan.stdout}\n`;
  await appendFile(knownHostsPath, line, 'utf8');
};

export const waitForSshReady = async (input: {
  readonly host: string;
  readonly user: string;
  readonly privateKeyPath: string;
  readonly timeoutMs?: number | undefined;
  readonly intervalMs?: number | undefined;
}): Promise<void> => {
  const target = formatSshTarget(input.user, input.host);
  await ensureKnownHost(input.host, input.privateKeyPath);
  const timeoutMs = input.timeoutMs ?? 120_000;
  const intervalMs = input.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await runCommand(
      ['ssh', ...sshBaseArgs(input.privateKeyPath), '--', target, 'echo ready'],
      { timeoutMs: 10_000 },
    );
    if (probe.code === 0 && probe.stdout.includes('ready')) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for SSH on ${target}`);
};

export const sshExec = async (input: {
  readonly host: string;
  readonly user: string;
  readonly privateKeyPath: string;
  readonly command: string;
  readonly timeoutMs?: number | undefined;
}): Promise<RunCommandResult> => {
  const target = formatSshTarget(input.user, input.host);
  assertSafeRemoteCommand(input.command);
  await ensureKnownHost(input.host, input.privateKeyPath);
  return await runCommand(
    ['ssh', ...sshBaseArgs(input.privateKeyPath), '--', target, input.command],
    { timeoutMs: input.timeoutMs ?? 120_000 },
  );
};

export const scpCopy = async (input: {
  readonly host: string;
  readonly user: string;
  readonly privateKeyPath: string;
  readonly localPath: string;
  readonly remotePath: string;
  readonly recursive?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<RunCommandResult> => {
  const target = formatSshTarget(input.user, input.host);
  await ensureKnownHost(input.host, input.privateKeyPath);
  return await runCommand(
    [
      'scp',
      ...(input.recursive ? ['-r'] : []),
      ...sshBaseArgs(input.privateKeyPath),
      '--',
      input.localPath,
      `${target}:${input.remotePath}`,
    ],
    { timeoutMs: input.timeoutMs ?? 180_000 },
  );
};

export const openInteractiveSsh = async (input: {
  readonly host: string;
  readonly user: string;
  readonly privateKeyPath: string;
}): Promise<number> => {
  const target = formatSshTarget(input.user, input.host);
  await ensureKnownHost(input.host, input.privateKeyPath);
  const proc = Bun.spawn({
    cmd: ['ssh', ...sshBaseArgs(input.privateKeyPath), '--', target],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
};
