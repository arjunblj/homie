import pc from 'picocolors';

export type DeployOutputMode = 'default' | 'verbose' | 'json' | 'quiet';

export interface DeployReporterOptions {
  readonly mode: DeployOutputMode;
  readonly useColor: boolean;
  readonly useUnicode: boolean;
}

const symbolsFor = (unicode: boolean): Record<'run' | 'ok' | 'warn' | 'fail' | 'info', string> => {
  if (unicode) {
    return {
      run: '⠋',
      ok: '✓',
      warn: '⚠',
      fail: '✗',
      info: 'ℹ',
    };
  }
  return {
    run: '...',
    ok: '[ok]',
    warn: '[warn]',
    fail: '[fail]',
    info: '[i]',
  };
};

const formatSeconds = (elapsedMs: number): string => `${(elapsedMs / 1000).toFixed(1)}s`;

const nowMs = (): number => Date.now();

export class DeployReporter {
  private readonly mode: DeployOutputMode;
  private readonly symbols: Record<'run' | 'ok' | 'warn' | 'fail' | 'info', string>;
  private readonly color: boolean;
  private readonly phaseStartedAt = new Map<string, number>();
  private totalStartedAt = nowMs();

  public constructor(options: DeployReporterOptions) {
    this.mode = options.mode;
    this.symbols = symbolsFor(options.useUnicode);
    this.color = options.useColor;
  }

  public beginSession(title: string, subtitle?: string): void {
    this.totalStartedAt = nowMs();
    if (this.mode === 'json') return;
    if (this.mode !== 'quiet') {
      process.stderr.write(`${title}\n`);
      if (subtitle) process.stderr.write(`${subtitle}\n`);
      process.stderr.write('\n');
    }
  }

  public phase(name: string): void {
    this.phaseStartedAt.set(name, nowMs());
    if (this.mode === 'json') {
      this.emitJson({ type: 'phase_start', phase: name });
      return;
    }
    if (this.mode !== 'quiet') process.stderr.write(`${this.styleHeader(name)}\n`);
  }

  public phaseDone(name: string): void {
    const startedAt = this.phaseStartedAt.get(name);
    const elapsed = startedAt ? nowMs() - startedAt : undefined;
    if (this.mode === 'json') {
      this.emitJson({
        type: 'phase_done',
        phase: name,
        ...(elapsed ? { elapsedMs: elapsed } : {}),
      });
      return;
    }
    if (this.mode !== 'quiet' && elapsed !== undefined) {
      process.stderr.write(
        `  ${this.styleDim(`${name} completed in ${formatSeconds(elapsed)}`)}\n\n`,
      );
    } else if (this.mode !== 'quiet') {
      process.stderr.write('\n');
    }
  }

  public run(message: string): number {
    const startedAt = nowMs();
    if (this.mode === 'json') {
      this.emitJson({ type: 'step_start', message });
      return startedAt;
    }
    if (this.mode !== 'quiet') {
      process.stderr.write(`  ${this.symbols.run} ${message}\n`);
    }
    return startedAt;
  }

  public ok(message: string, startedAt?: number): void {
    const elapsed = startedAt ? nowMs() - startedAt : undefined;
    if (this.mode === 'json') {
      this.emitJson({
        type: 'step_ok',
        message,
        ...(elapsed !== undefined ? { elapsedMs: elapsed } : {}),
      });
      return;
    }
    if (this.mode !== 'quiet') {
      process.stderr.write(
        `  ${this.styleOk(this.symbols.ok)} ${message}${elapsed !== undefined ? ` ${this.styleDim(`(${formatSeconds(elapsed)})`)}` : ''}\n`,
      );
    }
  }

  public warn(message: string): void {
    if (this.mode === 'json') {
      this.emitJson({ type: 'step_warn', message });
      return;
    }
    if (this.mode === 'quiet') return;
    process.stderr.write(`  ${this.styleWarn(this.symbols.warn)} ${message}\n`);
  }

  public fail(message: string): void {
    if (this.mode === 'json') {
      this.emitJson({ type: 'step_fail', message });
      return;
    }
    process.stderr.write(`  ${this.styleFail(this.symbols.fail)} ${message}\n`);
  }

  public info(message: string): void {
    if (this.mode === 'json') {
      this.emitJson({ type: 'step_info', message });
      return;
    }
    if (this.mode === 'quiet') return;
    process.stderr.write(`  ${this.styleDim(this.symbols.info)} ${message}\n`);
  }

  public detail(message: string): void {
    if (this.mode === 'json') {
      this.emitJson({ type: 'detail', message });
      return;
    }
    if (this.mode !== 'verbose') return;
    process.stderr.write(`    > ${this.styleDim(message)}\n`);
  }

  public summary(lines: readonly string[]): void {
    const elapsed = nowMs() - this.totalStartedAt;
    if (this.mode === 'json') {
      this.emitJson({ type: 'summary', elapsedMs: elapsed, lines });
      return;
    }
    process.stderr.write('Summary\n');
    for (const line of lines) process.stderr.write(`  ${line}\n`);
    process.stderr.write(`  ${this.styleDim(`total elapsed: ${formatSeconds(elapsed)}`)}\n`);
  }

  public emitResult(result: Record<string, unknown>): void {
    if (this.mode === 'json') {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
  }

  private emitJson(event: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  private styleHeader(value: string): string {
    if (!this.color) return value;
    return pc.bold(value);
  }

  private styleOk(value: string): string {
    if (!this.color) return value;
    return pc.green(value);
  }

  private styleWarn(value: string): string {
    if (!this.color) return value;
    return pc.yellow(value);
  }

  private styleFail(value: string): string {
    if (!this.color) return value;
    return pc.red(value);
  }

  private styleDim(value: string): string {
    if (!this.color) return value;
    return pc.dim(value);
  }
}

export const resolveDeployOutputMode = (input: {
  readonly json: boolean;
  readonly verbose: boolean;
  readonly quiet: boolean;
}): DeployOutputMode => {
  if (input.json) return 'json';
  if (input.quiet) return 'quiet';
  if (input.verbose) return 'verbose';
  return 'default';
};
