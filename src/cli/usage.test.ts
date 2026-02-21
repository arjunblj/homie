import { describe, expect, test } from 'bun:test';
import { helpForCmd, renderUsage } from './usage.js';

describe('cli usage', () => {
  test('documents deploy apply subcommand in global usage', () => {
    const usage = renderUsage(true);
    expect(usage).toContain('apply|status|resume|ssh|destroy');
  });

  test('documents deploy apply subcommand in command help', () => {
    const help = helpForCmd('deploy', true);
    expect(help).toBeTruthy();
    expect(help ?? '').toContain('[apply|status|resume|ssh|destroy]');
  });
});
