import { describe, expect, test } from 'bun:test';
import {
  knownHostsHasHostEntry,
  knownHostsPinsForHost,
  scpCopy,
  sshExec,
  waitForSshReady,
} from './ssh.js';

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

describe('knownHostsHasHostEntry', () => {
  test('matches exact host entries only', () => {
    const content = '143.198.1.10 ssh-ed25519 AAAATESTKEY';
    expect(knownHostsHasHostEntry(content, '143.198.1.10')).toBeTrue();
    expect(knownHostsHasHostEntry(content, '43.198.1.1')).toBeFalse();
  });

  test('matches hosts from comma-separated known_hosts entries', () => {
    const content = 'example.com,203.0.113.9 ssh-ed25519 AAAATESTKEY';
    expect(knownHostsHasHostEntry(content, 'example.com')).toBeTrue();
    expect(knownHostsHasHostEntry(content, '203.0.113.9')).toBeTrue();
  });

  test('handles marker-prefixed entries', () => {
    const content = '@cert-authority example.org ssh-ed25519 AAAATESTKEY';
    expect(knownHostsHasHostEntry(content, 'example.org')).toBeTrue();
  });
});

describe('knownHostsPinsForHost', () => {
  test('extracts unique key pins for a host', () => {
    const content = [
      'example.org ssh-ed25519 AAAATESTKEY',
      'example.org ssh-rsa AAAARSAKEY',
      'example.org ssh-ed25519 AAAATESTKEY',
    ].join('\n');
    expect(knownHostsPinsForHost(content, 'example.org')).toEqual([
      'ssh-ed25519 AAAATESTKEY',
      'ssh-rsa AAAARSAKEY',
    ]);
  });

  test('ignores entries for other hosts', () => {
    const content = 'other.example ssh-ed25519 AAAAOTHERKEY';
    expect(knownHostsPinsForHost(content, 'example.org')).toEqual([]);
  });
});
