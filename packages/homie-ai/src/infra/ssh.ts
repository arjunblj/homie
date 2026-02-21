import { mkdir, readFile } from 'node:fs/promises';
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

export const runShellCommand = async (
  command: string,
  options: SpawnShellOptions = {},
): Promise<RunCommandResult> => {
  const spawnOptions: Bun.SpawnOptions.OptionsObject<'pipe', 'pipe', 'pipe'> & { cmd: string[] } = {
    cmd: ['sh', '-lc', command],
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
    const result = await runShellCommand(
      `ssh-keygen -t ed25519 -N '' -f "${privateKeyPath}" -C homie-deploy`,
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

const sshBaseArgs = (privateKeyPath: string): string[] => [
  '-i',
  privateKeyPath,
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=8',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'UserKnownHostsFile=/dev/null',
];

export const waitForSshReady = async (input: {
  readonly host: string;
  readonly user: string;
  readonly privateKeyPath: string;
  readonly timeoutMs?: number | undefined;
  readonly intervalMs?: number | undefined;
}): Promise<void> => {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const intervalMs = input.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cmd = [
      'ssh',
      ...sshBaseArgs(input.privateKeyPath),
      `${input.user}@${input.host}`,
      'echo ready',
    ]
      .map((part) => `"${part.replaceAll('"', '\\"')}"`)
      .join(' ');
    const probe = await runShellCommand(cmd, { timeoutMs: 10_000 });
    if (probe.code === 0 && probe.stdout.includes('ready')) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for SSH on ${input.user}@${input.host}`);
};

export const sshExec = async (input: {
  readonly host: string;
  readonly user: string;
  readonly privateKeyPath: string;
  readonly command: string;
  readonly timeoutMs?: number | undefined;
}): Promise<RunCommandResult> => {
  const cmd = [
    'ssh',
    ...sshBaseArgs(input.privateKeyPath),
    `${input.user}@${input.host}`,
    input.command,
  ]
    .map((part) => `"${part.replaceAll('"', '\\"')}"`)
    .join(' ');
  return await runShellCommand(cmd, {
    timeoutMs: input.timeoutMs ?? 120_000,
  });
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
  const cmd = [
    'scp',
    ...(input.recursive ? ['-r'] : []),
    ...sshBaseArgs(input.privateKeyPath),
    input.localPath,
    `${input.user}@${input.host}:${input.remotePath}`,
  ]
    .map((part) => `"${part.replaceAll('"', '\\"')}"`)
    .join(' ');
  return await runShellCommand(cmd, {
    timeoutMs: input.timeoutMs ?? 180_000,
  });
};

export const openInteractiveSsh = async (input: {
  readonly host: string;
  readonly user: string;
  readonly privateKeyPath: string;
}): Promise<number> => {
  const proc = Bun.spawn({
    cmd: ['ssh', ...sshBaseArgs(input.privateKeyPath), `${input.user}@${input.host}`],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
};

