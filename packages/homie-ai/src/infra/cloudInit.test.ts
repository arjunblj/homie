import { describe, expect, test } from 'bun:test';
import { buildCloudInitUserData } from './cloudInit.js';

describe('buildCloudInitUserData', () => {
  test('includes required sections and hardening defaults', () => {
    const yaml = buildCloudInitUserData({
      authorizedSshPublicKeys: ['ssh-ed25519 AAAATEST test@host'],
    });
    expect(yaml).toContain('#cloud-config');
    expect(yaml).toContain('users:');
    expect(yaml).toContain('ssh_authorized_keys:');
    expect(yaml).toContain('PasswordAuthentication no');
    expect(yaml).toContain('mkdir -p /opt/homie');
  });

  test('supports custom user and runtime dir', () => {
    const yaml = buildCloudInitUserData({
      authorizedSshPublicKeys: ['ssh-ed25519 AAAATEST2 test2@host'],
      runtimeUser: 'deployer',
      runtimeDir: '/srv/homie',
    });
    expect(yaml).toContain('name: deployer');
    expect(yaml).toContain('mkdir -p /srv/homie');
    expect(yaml).toContain('chown -R deployer:deployer /srv/homie');
  });

  test('throws without public keys', () => {
    expect(() =>
      buildCloudInitUserData({
        authorizedSshPublicKeys: [],
      }),
    ).toThrow('at least one SSH public key');
  });
});
