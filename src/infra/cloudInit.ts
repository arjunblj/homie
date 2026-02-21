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

const quoteShell = (value: string): string => {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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

const RUNTIME_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;
const RUNTIME_DIR_PATTERN = /^\/[A-Za-z0-9._/-]*$/u;

const normalizeRuntimeUser = (raw: string | undefined): string => {
  const runtimeUser = raw?.trim() || 'openhomie';
  if (!RUNTIME_USER_PATTERN.test(runtimeUser)) {
    throw new Error(
      `cloud-init runtimeUser must match ${RUNTIME_USER_PATTERN.toString()} (got "${runtimeUser}")`,
    );
  }
  return runtimeUser;
};

const normalizeRuntimeDir = (raw: string | undefined): string => {
  const runtimeDir = raw?.trim() || '/opt/openhomie';
  if (!runtimeDir || !RUNTIME_DIR_PATTERN.test(runtimeDir) || runtimeDir.includes('..')) {
    throw new Error(`cloud-init runtimeDir must be a safe absolute path (got "${runtimeDir}")`);
  }
  return runtimeDir;
};

export const buildCloudInitUserData = (input: BuildCloudInitInput): string => {
  const runtimeUser = normalizeRuntimeUser(input.runtimeUser);
  const runtimeDir = normalizeRuntimeDir(input.runtimeDir);
  const runtimeUserShell = quoteShell(runtimeUser);
  const runtimeDirShell = quoteShell(runtimeDir);
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
  lines.push(`  - name: ${quoteYaml(runtimeUser)}`);
  lines.push('    gecos: Openhomie Runtime');
  lines.push('    shell: /bin/bash');
  lines.push('    groups: [docker, sudo]');
  lines.push('    sudo: ALL=(ALL) NOPASSWD:ALL');
  lines.push('    lock_passwd: true');
  lines.push('    ssh_authorized_keys:');
  for (const key of keys) {
    lines.push(`      - ${quoteYaml(key)}`);
  }
  lines.push('write_files:');
  lines.push('  - path: /etc/ssh/sshd_config.d/99-openhomie-hardening.conf');
  lines.push('    permissions: "0644"');
  lines.push('    content: |');
  if (input.disablePasswordAuth ?? true) {
    lines.push('      PasswordAuthentication no');
    lines.push('      ChallengeResponseAuthentication no');
  }
  lines.push('      PubkeyAuthentication yes');
  lines.push('runcmd:');
  lines.push(`  - mkdir -p ${runtimeDirShell}`);
  lines.push(`  - mkdir -p ${runtimeDirShell}/identity ${runtimeDirShell}/data`);
  lines.push(`  - chown -R ${runtimeUserShell}:${runtimeUserShell} ${runtimeDirShell}`);
  lines.push('  - systemctl enable docker');
  lines.push('  - systemctl restart docker');
  lines.push('  - systemctl restart ssh || systemctl restart sshd || true');

  return `${lines.join('\n')}\n`;
};
