import { describe, expect, test } from 'bun:test';
import { assertGolden } from '../testing/golden.js';
import { helpForCmd, renderUsage } from './usage.js';

describe('cli usage', () => {
  test('golden: global usage output (noColor)', async () => {
    const usage = renderUsage(true);
    await assertGolden(usage, 'src/cli/__goldens__/usage.txt');
    expect(usage).toContain('deploy');
  });

  test('golden: deploy help output (noColor)', async () => {
    const help = helpForCmd('deploy', true) ?? '';
    await assertGolden(help, 'src/cli/__goldens__/help.deploy.txt');
    expect(help).toContain('deploy');
  });
});
