# Bun CLI/TUI Production Readiness Guide

> Research compiled Feb 2026. Covers Bun-specific build/distribution, Ink stack risks, startup optimization, cross-platform terminal behavior, logging/telemetry, and CI validation for polished CLI products.

---

## 1. Recommended Build/Distribution Setup for Bun Monorepo CLI

### Current homie-ai Build (Baseline)

```json
"build": "rm -rf dist && tsc -p tsconfig.build.json && bun build ./src/index.ts --outdir dist --target bun --format esm --sourcemap && bun build ./src/cli.ts --outdir dist --target bun --format esm --sourcemap"
```

- Emits `dist/cli.js` (ESM bundle) + declarations
- CLI entry: `bin.homie` → `./dist/cli.js`
- Runs via `bun run homie` or `bun ./dist/cli.js`

### Recommended Production Build (Single Binary + Bytecode)

For distribution as a standalone executable (no Bun/Node install required):

```bash
# Single-file executable with bytecode (best startup)
bun build ./src/cli.ts \
  --compile \
  --bytecode \
  --minify \
  --sourcemap \
  --target=bun \
  --outfile=dist/homie
```

**Monorepo workflow:**

```json
{
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.build.json && bun build ./src/index.ts --outdir dist --target bun --format esm --sourcemap && bun build ./src/cli.ts --outdir dist --target bun --format esm --sourcemap",
    "build:binary": "bun run build && bun build ./src/cli.ts --compile --bytecode --minify --sourcemap --target=bun --outfile=dist/homie",
    "build:release": "bun run build:binary && ./scripts/build-matrix.sh"
  }
}
```

**Cross-platform matrix script** (`scripts/build-matrix.sh`):

```bash
#!/bin/bash
# Build for all targets; run on CI per-OS or use Docker
TARGETS=(
  "bun-darwin-arm64"
  "bun-darwin-x64"
  "bun-linux-x64"
  "bun-linux-arm64"
  "bun-windows-x64"
)
for t in "${TARGETS[@]}"; do
  bun build ./src/cli.ts --compile --bytecode --minify --target="$t" --outfile="dist/homie-$t"
done
```

### Build-Time Constants

Embed version and env for production:

```bash
bun build ./src/cli.ts --compile --bytecode --minify \
  --define BUILD_VERSION='"'"$(node -p "require('./package.json').version")"'"' \
  --define NODE_ENV='"production"' \
  --outfile=dist/homie
```

### Distribution Options

| Method | Use Case | Notes |
|--------|----------|-------|
| **npm package** | `bunx homie` / `npx homie` | Ship `dist/cli.js` + `dist/*.d.ts`; `engines.bun` pins runtime |
| **Standalone binary** | GitHub Releases, direct download | Single file, no runtime; cross-compile per target |
| **Homebrew** | macOS/Linux | Formula fetches binary from Releases |

### Bytecode Trade-offs

| Benefit | Cost |
|---------|------|
| 1.5–4x faster startup (scales with bundle size) | `.jsc` 2–8x larger than `.js` |
| No parsing at runtime | Not portable across Bun versions; regenerate on upgrade |
| Architecture-independent | Must ship both `.js` + `.jsc` (or embed in binary) |

**Best practice:** Generate bytecode in CI; do not commit `.jsc` to git. Regenerate when Bun version changes.

---

## 2. Startup-Time Optimization Patterns

### Layered Optimizations

1. **Bytecode** — Pre-compile JS to bytecode; eliminates parse + initial compile
2. **Minify** — Smaller bundle → less bytecode; use `--minify` before `--bytecode`
3. **Lazy load Ink** — Only import Ink when entering interactive mode (e.g. `homie chat`); keep `homie --help` / `homie doctor` fast without React
4. **Defer heavy deps** — Load AI SDK, grammy, etc. only when needed; avoid top-level imports for rarely-used commands

### Lazy Ink Entry Pattern

```ts
// cli/runCli.ts
if (args.command === 'chat' || args.command === 'interactive') {
  const { runCliChat } = await import('../channels/cli.js');
  await runCliChat({ config, engine });
} else {
  // Non-interactive: no Ink, no React
  await runCommand(args);
}
```

### Benchmarking Startup

```bash
# Time to first output
time (bun ./dist/cli.js --help > /dev/null)

# With bytecode
time (bun ./dist/cli.js --help > /dev/null)
```

Target: <100ms for `--help` on modern hardware.

---

## 3. Risk List: Bun + Ink Stack with Mitigations

### High Priority

| Risk | Description | Mitigation |
|------|-------------|------------|
| **react-devtools-core in prod** | Ink lists it as optional peer; if pulled in, adds dev-only code and potential startup cost | Use `optionalDependencies` or ensure it's not imported in prod. Ink treats it as optional; verify with `bun pm ls` that it's not pulling heavy code paths. Consider `NODE_ENV=production` to skip DevTools init if any. |
| **readline / stdin issues** | `readline.close()` can leave stdin unresponsive in Bun; Ink's `useInput` uses raw mode | Test Ctrl+C, Tab, Escape on Bun 1.3+. If issues persist, track [oven-sh/bun#10694](https://github.com/oven-sh/bun/issues/10694). Fallback: document Node as supported runtime. |
| **stdin.ref()** | Older Bun (1.2) had `stdin.ref()` undefined | Pin `engines.bun` to `>=1.3.0`; test on minimum version. |
| **Bytecode version lock** | Bytecode invalidated on Bun upgrade | Regenerate in CI on every Bun version bump; don't ship stale `.jsc`. |

### Medium Priority

| Risk | Description | Mitigation |
|------|-------------|------------|
| **Ink fullscreen regression** | Ink v6 #752: blank row at bottom in fullscreen | Use inline mode (homie's current approach) or test fullscreen before adopting. |
| **Streaming flicker** | Token-by-token `setState` causes full-tree re-renders | Use buffered batching (50ms) + `<Static>` for completed messages; see `docs/ink-ai-sdk-integration-patterns.md`. |
| **Windows ANSI** | Legacy Windows Console may not support ANSI | Use `picocolors`/`chalk` (Ink uses these); Windows 10+ with VirtualTerminalLevel=1 supports ANSI. Document Windows Terminal / WT as recommended. |
| **CI without TTY** | Ink expects TTY; CI often has no stdin | Guard: `if (process.stdin.isTTY)` before `render()`; fall back to non-interactive output. |

### Low Priority

| Risk | Description | Mitigation |
|------|-------------|------------|
| **Ink input on older Bun** | `useInput` historically broken on Bun &lt;1.3 | Enforce `engines.bun`; document in README. |
| **Large binary size** | Compiled binary embeds Bun runtime | Accept for UX; document size in release notes. |

---

## 4. Cross-Platform Terminal Behavior Gotchas

### ANSI Support

| Platform | Native ANSI | Notes |
|----------|-------------|-------|
| macOS / Linux | Yes | No special handling |
| Windows 10+ | Yes (with VT) | Set `VirtualTerminalLevel=1` or use Windows Terminal |
| Legacy Windows | No | Use colorama-style wrapper or strip ANSI |

### Safe Escape Code Subset

For maximum compatibility:

- 16-color: `[30m`–`[37m` (fg), `[40m`–`[47m` (bg)
- 256-color: `[38;5;Cm`, `[48;5;Cm`
- Attributes: bold `[1m`, dim `[2m`, reset `[0m`

Avoid: cursor positioning hacks, alternate screen buffer (unless required for fullscreen).

### Terminal Size / Resize

- Use `process.stdout.columns` / `process.stdout.rows` or Ink's `useStdout`; handle `undefined` in non-TTY.
- Resize can clear content; design for re-render on resize.

### Path Normalization in Snapshots

- Use filters to redact `process.cwd()`, `os.tmpdir()`, `$HOME`, platform-specific path separators.
- Enables portable snapshot tests across macOS/Linux/Windows.

---

## 5. Logging / Telemetry Patterns for Local-First CLI

### Principles (from Go Telemetry, Russ Cox)

- **Local-first:** Collect only what's needed; store locally by default.
- **Opt-in for upload:** Default off; explicit user consent for any remote reporting.
- **Minimal data:** No PII, no prompts/responses, no API keys.

### homie-ai Current Approach

- JSON lines to stderr, level via `HOMIE_LOG_LEVEL`
- Redaction of API keys, tokens, Bearer, etc.
- `log.fatal` on crash with `errorFields` (redacted)

### Recommended Additions

| Pattern | Implementation |
|--------|-----------------|
| **Structured logs** | Keep current JSON format; add `command`, `duration_ms`, `exit_code` for analytics-ready local logs |
| **Crash reports** | Local file (e.g. `~/.homie/crashes/`) with redacted stack; no auto-upload |
| **Opt-in telemetry** | `HOMIE_TELEMETRY=1` or `homie config set telemetry on`; only then send anonymized events (e.g. command names, success/fail, latency) |
| **First-run prompt** | "Help improve homie: enable anonymous usage stats? (y/n)" — store in config |

### What Not to Collect

- Message content, prompts, model output
- API keys, tokens, credentials
- File paths, project structure
- User identifiers unless explicitly provided

---

## 6. CI Validation Matrix for CLI UX Stability

### Test Layers

| Layer | Purpose | Tools |
|-------|---------|-------|
| **Unit** | Args, config, business logic | `bun test` |
| **Integration** | Spawn CLI, assert stdout/stderr/exit | `bun test` + `spawn` |
| **Snapshot** | Output regression | Filtered snapshots |
| **E2E (optional)** | Full flow in real TTY | Manual or dedicated E2E runner |

### Snapshot Strategy

```ts
// Example: cli-output.test.ts
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function normalizeOutput(s: string): string {
  return s
    .replace(process.cwd(), '<CWD>')
    .replace(tmpdir(), '<TMP>')
    .replace(/\/Users\/[^/]+/g, '<HOME>')
    .replace(/\\Users\\[^\\]+/g, '<HOME>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ISO8601>');
}

test('homie --help snapshot', async () => {
  const { stdout, stderr } = await spawnCapture('bun', ['./dist/cli.js', '--help']);
  expect(normalizeOutput(stdout + stderr)).toMatchSnapshot();
});
```

### CI Matrix

```yaml
# .github/workflows/cli.yml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    bun: ['1.3']
steps:
  - uses: oven-sh/setup-bun@v2
    with:
      bun-version: ${{ matrix.bun }}
  - run: bun install --frozen-lockfile
  - run: bun run build
  - run: bun test
  - run: bun ./dist/cli.js --help  # Smoke test
  - run: bun ./dist/cli.js doctor  # Non-interactive validation
```

### Platform-Specific Checks

| Check | Purpose |
|-------|---------|
| `homie --help` | Entry point, no Ink |
| `homie doctor` | Config/health, no TTY required |
| `homie init` (non-interactive) | With `--yes` or piped input |
| Snapshot `--help` output | Cross-platform path/version normalization |

### Avoiding TTY-Dependent Failures in CI

- Skip `render(<App />)` when `!process.stdin.isTTY`; emit plain text instead.
- Use `is-ci` or `CI` env to force non-interactive mode in tests.

---

## 7. Production Readiness Checklist for Terminal UX

### Build & Distribution

- [ ] `bun run build` produces working `dist/cli.js`
- [ ] `engines.bun` and `engines.node` specified in package.json
- [ ] Optional: standalone binary build for GitHub Releases
- [ ] Bytecode regenerated on Bun version bump (CI)
- [ ] `--define` for version/NODE_ENV in release builds

### Startup

- [ ] `homie --help` exits in <150ms on target hardware
- [ ] Lazy-load Ink for interactive-only commands
- [ ] No top-level imports of heavy deps for fast paths

### Ink / TUI

- [ ] Buffered streaming (50ms) + `<Static>` for completed messages
- [ ] Ctrl+C exits cleanly; no orphaned processes
- [ ] `patchConsole: false` if you need raw console output
- [ ] Test in Windows Terminal, iTerm2, default macOS Terminal

### Dependencies

- [ ] `react-devtools-core` not on critical path in production
- [ ] No dev-only code in production bundle (tree-shake or conditional imports)

### Cross-Platform

- [ ] Path filters in snapshot tests (CWD, TMP, HOME)
- [ ] ANSI used via chalk/picocolors (handles Windows 10+)
- [ ] Document Windows Terminal as recommended on Windows

### Logging & Privacy

- [ ] Sensitive data redacted (keys, tokens, paths if needed)
- [ ] Telemetry opt-in only; no auto-upload by default
- [ ] Crash logs local-only unless user opts in

### CI

- [ ] Matrix: ubuntu, macos, windows × Bun 1.3
- [ ] `bun test` passes on all platforms
- [ ] Smoke: `homie --help`, `homie doctor`
- [ ] Snapshot tests with portable filters

### Documentation

- [ ] README: install (bunx/npm/binary), min Bun version
- [ ] Known limitations (e.g. stdin on older Bun)
- [ ] Telemetry opt-in instructions if applicable

---

## References

- [Bun Single-file executable](https://bun.sh/docs/bundler/executables)
- [Bun Bytecode Caching](https://bun.sh/docs/bundler/bytecode)
- [Ink + AI SDK patterns](./ink-ai-sdk-integration-patterns.md)
- [Streaming terminal patterns](./streaming-terminal-patterns.md)
- [Bun readline stdin issue](https://github.com/oven-sh/bun/issues/10694)
- [Safe terminal escape codes](https://www.arp242.net/safeterm.html)
- [Go Telemetry (opt-in)](https://go.dev/doc/telemetry)
