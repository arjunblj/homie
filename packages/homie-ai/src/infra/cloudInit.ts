export interface BuildCloudInitInput {
  readonly authorizedSshPublicKeys: readonly string[];
  readonly runtimeUser?: string | undefined;
  readonly runtimeDir?: string | undefined;
  readonly installPackages?: readonly string[] | undefined;
  readonly disablePasswordAuth?: boolean | undefined;
}

const quoteYaml = (value: string): string => {
  return `'${value.replaceAll("'", "''")}'`;
};

const dedupe = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

export const buildCloudInitUserData = (input: BuildCloudInitInput): string => {
  const runtimeUser = input.runtimeUser?.trim() || 'homie';
  const runtimeDir = input.runtimeDir?.trim() || '/opt/homie';
  const keys = dedupe(input.authorizedSshPublicKeys);
  const packages = dedupe(input.installPackages ?? ['curl', 'ca-certificates', 'docker.io']);
  if (keys.length === 0) {
    throw new Error('cloud-init requires at least one SSH public key');
  }

  const lines: string[] = [];
  lines.push('#cloud-config');
  lines.push('package_update: true');
  lines.push(`packages: [${packages.map((item) => quoteYaml(item)).join(', ')}]`);
  lines.push('users:');
  lines.push(`  - name: ${runtimeUser}`);
  lines.push('    gecos: Homie Runtime');
  lines.push('    shell: /bin/bash');
  lines.push('    groups: [docker, sudo]');
  lines.push('    sudo: ALL=(ALL) NOPASSWD:ALL');
  lines.push('    lock_passwd: true');
  lines.push('    ssh_authorized_keys:');
  for (const key of keys) {
    lines.push(`      - ${quoteYaml(key)}`);
  }
  lines.push('write_files:');
  lines.push('  - path: /etc/ssh/sshd_config.d/99-homie-hardening.conf');
  lines.push('    permissions: "0644"');
  lines.push('    content: |');
  if (input.disablePasswordAuth ?? true) {
    lines.push('      PasswordAuthentication no');
    lines.push('      ChallengeResponseAuthentication no');
  }
  lines.push('      PubkeyAuthentication yes');
  lines.push('runcmd:');
  lines.push(`  - mkdir -p ${runtimeDir}`);
  lines.push(`  - mkdir -p ${runtimeDir}/identity ${runtimeDir}/data`);
  lines.push(`  - chown -R ${runtimeUser}:${runtimeUser} ${runtimeDir}`);
  lines.push('  - systemctl enable docker');
  lines.push('  - systemctl restart docker');
  lines.push('  - systemctl restart ssh || systemctl restart sshd || true');

  return `${lines.join('\n')}\n`;
};
