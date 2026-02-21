import { describe, expect, spyOn, test } from 'bun:test';
import { DeployReporter, resolveDeployOutputMode } from './deployOutput.js';

describe('resolveDeployOutputMode', () => {
  test('prefers json mode', () => {
    expect(resolveDeployOutputMode({ json: true, verbose: true, quiet: true })).toBe('json');
  });

  test('uses quiet when requested', () => {
    expect(resolveDeployOutputMode({ json: false, verbose: false, quiet: true })).toBe('quiet');
  });

  test('uses verbose when requested', () => {
    expect(resolveDeployOutputMode({ json: false, verbose: true, quiet: false })).toBe('verbose');
  });

  test('defaults to standard mode', () => {
    expect(resolveDeployOutputMode({ json: false, verbose: false, quiet: false })).toBe('default');
  });
});

describe('DeployReporter', () => {
  test('suppresses summary output in quiet mode', () => {
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const reporter = new DeployReporter({ mode: 'quiet', useColor: false, useUnicode: false });
      reporter.summary(['line one']);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test('emits structured events in json mode', () => {
    const stdoutChunks: string[] = [];
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
      stdoutChunks.push(String(args[0]));
      return true;
    });
    try {
      const reporter = new DeployReporter({ mode: 'json', useColor: false, useUnicode: false });
      reporter.phase('Provision');
      reporter.ok('created droplet');
      reporter.summary(['done']);
      expect(stdoutChunks.join('')).toContain('"type":"phase_start"');
      expect(stdoutChunks.join('')).toContain('"type":"step_ok"');
      expect(stdoutChunks.join('')).toContain('"type":"summary"');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
