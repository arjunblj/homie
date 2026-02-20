import { describe, expect, spyOn, test } from 'bun:test';

import { resolveSignalDaemonUrl, runDoctorCommand } from './doctor.js';

const baseOpts = {
  help: false,
  json: true,
  force: false,
  interactive: false,
  yes: false,
  verifyMpp: false,
} as const;

describe('cli/commands/doctor', () => {
  test('exports runDoctorCommand as a function', () => {
    expect(typeof runDoctorCommand).toBe('function');
  });

  test('reports config load failure with init hint in JSON mode', async () => {
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
      chunks.push(String(args[0]));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);

    try {
      await runDoctorCommand(baseOpts, async () => {
        throw new Error('Could not find homie.toml');
      });

      const json = JSON.parse(chunks.join(''));
      expect(json.result).toBe('FAIL');
      expect(json.issues).toHaveLength(1);
      expect(json.issues[0]).toContain('Could not find homie.toml');
      expect(json.issues[0]).toContain('Run `homie init`');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('reports generic config error without init hint in JSON mode', async () => {
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
      chunks.push(String(args[0]));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);

    try {
      await runDoctorCommand(baseOpts, async () => {
        throw new Error('invalid schema');
      });

      const json = JSON.parse(chunks.join(''));
      expect(json.result).toBe('FAIL');
      expect(json.issues[0]).toBe('config: invalid schema');
      expect(json.issues[0]).not.toContain('homie init');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe('resolveSignalDaemonUrl', () => {
  test('prefers SIGNAL_DAEMON_URL and trims trailing slash', () => {
    expect(
      resolveSignalDaemonUrl({
        SIGNAL_DAEMON_URL: 'http://localhost:8080/',
        SIGNAL_HTTP_URL: 'http://localhost:8081',
        SIGNAL_API_URL: 'http://localhost:8082',
      }),
    ).toBe('http://localhost:8080');
  });

  test('falls back through SIGNAL_HTTP_URL then SIGNAL_API_URL', () => {
    expect(
      resolveSignalDaemonUrl({
        SIGNAL_DAEMON_URL: '   ',
        SIGNAL_HTTP_URL: 'http://localhost:8081/',
        SIGNAL_API_URL: 'http://localhost:8082',
      }),
    ).toBe('http://localhost:8081');

    expect(
      resolveSignalDaemonUrl({
        SIGNAL_DAEMON_URL: '',
        SIGNAL_HTTP_URL: '',
        SIGNAL_API_URL: 'http://localhost:8082/',
      }),
    ).toBe('http://localhost:8082');
  });
});
