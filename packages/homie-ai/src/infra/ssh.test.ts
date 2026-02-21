import { describe, expect, test } from 'bun:test';
import { scpCopy, sshExec, waitForSshReady } from './ssh.js';

describe('ssh input validation', () => {
  test('waitForSshReady rejects invalid ssh users', async () => {
    await expect(
      waitForSshReady({
        host: '127.0.0.1',
        user: 'bad user',
        privateKeyPath: '/tmp/id_ed25519',
        timeoutMs: 1,
        intervalMs: 1,
      }),
    ).rejects.toThrow('Invalid SSH user');
  });

  test('waitForSshReady rejects invalid ssh hosts', async () => {
    await expect(
      waitForSshReady({
        host: '127.0.0.1;rm -rf /',
        user: 'root',
        privateKeyPath: '/tmp/id_ed25519',
        timeoutMs: 1,
        intervalMs: 1,
      }),
    ).rejects.toThrow('Invalid SSH host');
  });

  test('sshExec rejects invalid ssh hosts', async () => {
    await expect(
      sshExec({
        host: '$(evil-host)',
        user: 'homie',
        privateKeyPath: '/tmp/id_ed25519',
        command: 'echo ok',
      }),
    ).rejects.toThrow('Invalid SSH host');
  });

  test('sshExec rejects multi-line commands', async () => {
    await expect(
      sshExec({
        host: '127.0.0.1',
        user: 'homie',
        privateKeyPath: '/tmp/id_ed25519',
        command: 'echo ok\nwhoami',
      }),
    ).rejects.toThrow('SSH command must be a single line');
  });

  test('scpCopy rejects invalid ssh users', async () => {
    await expect(
      scpCopy({
        host: 'example.com',
        user: 'bad user',
        privateKeyPath: '/tmp/id_ed25519',
        localPath: '/tmp/a',
        remotePath: '/tmp/b',
      }),
    ).rejects.toThrow('Invalid SSH user');
  });
});
