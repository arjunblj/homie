import { privateKeyToAccount } from 'viem/accounts';
import type { LoadedOpenhomieConfig } from '../../config/load.js';
import { SqliteFeedbackStore } from '../../feedback/sqlite.js';
import { getIdentityPaths } from '../../identity/load.js';
import { defaultDeployStatePath, loadDeployState } from '../../infra/deployState.js';
import { detectProviderAvailability } from '../../llm/detect.js';
import { SqliteMemoryStore } from '../../memory/sqlite.js';
import { SqliteSessionStore } from '../../session/sqlite.js';
import { SqliteTelemetryStore } from '../../telemetry/sqlite.js';
import { shortAddress } from '../../util/format.js';
import { fileExists } from '../../util/fs.js';
import { MPP_KEY_PATTERN, resolveMppRpcUrl } from '../../util/mpp.js';
import {
  createTempoClient,
  getAgentBalance,
  isValidAgentRuntimePrivateKey,
  OPENHOMIE_AGENT_KEY_ENV,
  TEMPO_CHAIN_ID,
  TEMPO_MODERATO_RPC_URL,
} from '../../wallet/runtime.js';
import type { GlobalOpts } from '../args.js';
import { MppVerifyError, verifyMppModelAccess } from './mppVerify.js';

interface DoctorEnv extends NodeJS.ProcessEnv {
  OPENHOMIE_AGENT_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  MPP_PRIVATE_KEY?: string;
  MPP_RPC_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  SIGNAL_DAEMON_URL?: string;
  SIGNAL_HTTP_URL?: string;
  SIGNAL_API_URL?: string;
  BRAVE_API_KEY?: string;
}

export const resolveSignalDaemonUrl = (
  env: Pick<DoctorEnv, 'SIGNAL_DAEMON_URL' | 'SIGNAL_HTTP_URL' | 'SIGNAL_API_URL'>,
): string =>
  (
    env.SIGNAL_DAEMON_URL?.trim() ||
    env.SIGNAL_HTTP_URL?.trim() ||
    env.SIGNAL_API_URL?.trim() ||
    ''
  ).replace(/\/+$/u, '');

const hasLocalExecutable = (name: string): boolean => {
  if (typeof Bun === 'undefined' || typeof Bun.which !== 'function') return false;
  return Boolean(Bun.which(name));
};

export async function runDoctorCommand(
  opts: GlobalOpts,
  loadCfg: () => Promise<LoadedOpenhomieConfig>,
): Promise<void> {
  const issues: string[] = [];
  const warns: string[] = [];

  const env = process.env as DoctorEnv;

  let loaded: LoadedOpenhomieConfig | null = null;
  try {
    loaded = await loadCfg();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = msg.includes('Could not find homie.toml')
      ? ' Run `homie init` to create one.'
      : '';
    issues.push(`config: ${msg}${hint}`);
  }

  if (loaded) {
    const cfg = loaded.config;
    if (!opts.json) process.stdout.write(`config: ${loaded.configPath}\n`);

    const agentKey = env[OPENHOMIE_AGENT_KEY_ENV]?.trim() ?? '';
    if (!agentKey) {
      issues.push(`wallet: missing ${OPENHOMIE_AGENT_KEY_ENV}`);
    } else if (!isValidAgentRuntimePrivateKey(agentKey)) {
      issues.push(`wallet: invalid ${OPENHOMIE_AGENT_KEY_ENV} format (expected 0x + 64 hex chars)`);
    } else {
      const agentAddress = privateKeyToAccount(agentKey as `0x${string}`).address;
      if (!opts.json)
        process.stdout.write(`wallet: agent key detected (${shortAddress(agentAddress)})\n`);
      const tempoClient = createTempoClient(TEMPO_MODERATO_RPC_URL);
      try {
        const chainIdHex = (await tempoClient.request({ method: 'eth_chainId' })) as string;
        const chainId = Number.parseInt(chainIdHex, 16);
        if (chainId !== TEMPO_CHAIN_ID) {
          warns.push(
            `wallet: Tempo RPC chain mismatch (expected ${TEMPO_CHAIN_ID}, got ${chainId})`,
          );
        } else if (!opts.json) {
          process.stdout.write('wallet: Tempo RPC reachable\n');
        }
      } catch (_err) {
        warns.push(`wallet: Tempo RPC unreachable (${TEMPO_MODERATO_RPC_URL})`);
      }
      if (opts.verifyMpp) {
        try {
          const balance = await getAgentBalance({ address: agentAddress, client: tempoClient });
          if (!opts.json)
            process.stdout.write(`wallet: agent pathUSD balance ${balance.toString()}\n`);
        } catch (_err) {
          warns.push('wallet: could not read agent balance from Tempo RPC');
        }
      }
    }

    // Provider sanity checks (keys only; avoid network calls in doctor by default).
    if (cfg.model.provider.kind === 'anthropic') {
      if (!env.ANTHROPIC_API_KEY?.trim()) {
        issues.push('model: missing ANTHROPIC_API_KEY');
      }
    } else if (
      cfg.model.provider.kind === 'claude-code' ||
      cfg.model.provider.kind === 'codex-cli'
    ) {
      const availability = await detectProviderAvailability(env, { timeoutMs: 2_500 });
      if (cfg.model.provider.kind === 'claude-code') {
        if (!availability.hasClaudeCodeCli) {
          issues.push('model: claude-code selected but `claude` CLI is not available on PATH');
        } else if (!availability.hasClaudeAuth) {
          issues.push(
            'model: claude-code selected but not logged in (`claude auth status` failed)',
          );
        }
      } else {
        if (!availability.hasCodexCli) {
          issues.push('model: codex-cli selected but `codex` CLI is not available on PATH');
        } else if (!availability.hasCodexAuth) {
          issues.push('model: codex-cli selected but not logged in (`codex login status` failed)');
        }
      }
    } else if (cfg.model.provider.kind === 'mpp') {
      const key = env.MPP_PRIVATE_KEY?.trim() ?? '';
      const rpcUrl = resolveMppRpcUrl(env);
      if (!rpcUrl) {
        issues.push('model: missing MPP_RPC_URL');
      } else {
        const lowerRpcUrl = rpcUrl.toLowerCase();
        if (lowerRpcUrl.includes('base.org') || lowerRpcUrl.includes('mainnet.base')) {
          issues.push(`model: invalid MPP_RPC_URL (${rpcUrl}) — use a Tempo RPC endpoint`);
        } else if (!opts.json) {
          process.stdout.write(`model: MPP rpc configured (${rpcUrl})\n`);
        }
      }
      if (!key) {
        issues.push('model: missing MPP_PRIVATE_KEY');
      } else if (!MPP_KEY_PATTERN.test(key)) {
        issues.push('model: invalid MPP_PRIVATE_KEY format (expected 0x + 64 hex chars)');
      } else {
        const address = privateKeyToAccount(key as `0x${string}`).address;
        if (!opts.json)
          process.stdout.write(`model: MPP key detected (${shortAddress(address)})\n`);
        const baseUrl = (cfg.model.provider.baseUrl ?? 'https://mpp.tempo.xyz').replace(
          /\/+$/u,
          '',
        );
        const probeUrl = `${baseUrl}/llms.txt`;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5_000);
          try {
            const res = await fetch(probeUrl, { signal: controller.signal });
            if (res.ok) {
              if (!opts.json) process.stdout.write('model: MPP proxy reachable (llms index OK)\n');
            } else {
              warns.push(
                `model: MPP proxy returned ${String(res.status)} on free probe (${probeUrl})`,
              );
            }
          } finally {
            clearTimeout(timer);
          }
        } catch (_err) {
          warns.push(`model: MPP proxy unreachable (${probeUrl})`);
        }
        if (opts.verifyMpp) {
          if (!opts.json) {
            process.stdout.write(
              'model: paid verify probe enabled (this can incur a tiny payment)\n',
            );
          }
          try {
            await verifyMppModelAccess({
              env,
              model: cfg.model.models.fast,
              baseUrl,
              timeoutMs: 12_000,
            });
            if (!opts.json) process.stdout.write('model: MPP model verification OK\n');
          } catch (err) {
            if (err instanceof MppVerifyError) {
              issues.push(
                `model: MPP verification failed [${err.failure.code}] ${err.failure.detail}. ${err.failure.nextStep}`,
              );
            } else {
              const msg = err instanceof Error ? err.message : String(err);
              issues.push(`model: MPP verification failed (${msg})`);
            }
          }
        }
      }
    } else {
      const baseUrl = cfg.model.provider.baseUrl ?? env.OPENAI_BASE_URL;
      if (!baseUrl) issues.push('model: missing model.base_url / OPENAI_BASE_URL');
      if (String(baseUrl ?? '').includes('openrouter.ai') && !env.OPENROUTER_API_KEY?.trim()) {
        issues.push('model: missing OPENROUTER_API_KEY');
      }
      if (String(baseUrl ?? '').includes('api.openai.com') && !env.OPENAI_API_KEY?.trim()) {
        issues.push('model: missing OPENAI_API_KEY');
      }
      if (opts.verifyMpp) {
        warns.push('model: --verify-mpp ignored because provider is not mpp');
      }
    }

    // SQLite stores (only check if data dir exists — don't create db files as a side effect)
    {
      const dataDir = cfg.paths.dataDir;
      const stores: { close(): void }[] = [];
      try {
        if (await fileExists(`${dataDir}/sessions.db`)) {
          const sessions = new SqliteSessionStore({ dbPath: `${dataDir}/sessions.db` });
          stores.push(sessions);
          sessions.ping();
        }
        if (await fileExists(`${dataDir}/memory.db`)) {
          const memory = new SqliteMemoryStore({ dbPath: `${dataDir}/memory.db` });
          stores.push(memory);
          memory.ping();
        }
        if (await fileExists(`${dataDir}/feedback.db`)) {
          const feedback = new SqliteFeedbackStore({ dbPath: `${dataDir}/feedback.db` });
          stores.push(feedback);
          feedback.ping();
        }
        if (await fileExists(`${dataDir}/telemetry.db`)) {
          const telemetry = new SqliteTelemetryStore({ dbPath: `${dataDir}/telemetry.db` });
          stores.push(telemetry);
          telemetry.ping();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(`sqlite: ${msg}`);
      } finally {
        for (const s of stores) {
          try {
            s.close();
          } catch (_err) {
            /* best effort */
          }
        }
      }
    }

    // Identity files
    try {
      const paths = getIdentityPaths(cfg.paths.identityDir);
      const required = [
        paths.soulPath,
        paths.stylePath,
        paths.userPath,
        paths.firstMeetingPath,
        paths.personalityPath,
      ];
      for (const p of required) {
        if (!(await fileExists(p))) issues.push(`identity: missing ${p}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`identity: ${msg}`);
    }

    // Channels: verify connectivity, not just env vars.
    const hasTelegram = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
    const signalUrl = resolveSignalDaemonUrl(env);
    const hasSignal = Boolean(signalUrl);
    if (!hasTelegram && !hasSignal) {
      warns.push(
        'channels: neither Telegram nor Signal configured — your friend is only reachable via `homie chat`',
      );
    }

    if (hasTelegram) {
      const tgToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7_000);
        try {
          const res = await fetch(`https://api.telegram.org/bot${tgToken}/getMe`, {
            signal: controller.signal,
          });
          const body = (await res.json().catch(() => null)) as {
            ok?: boolean;
            result?: { username?: unknown };
          } | null;
          if (res.ok && body?.ok === true) {
            const username = typeof body?.result?.username === 'string' ? body.result.username : '';
            if (!opts.json) process.stdout.write(`telegram: connected as @${username}\n`);
          } else {
            issues.push('telegram: bot token is invalid or expired');
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (_err) {
        warns.push('telegram: could not reach Telegram API (network issue?)');
      }
    }

    if (hasSignal) {
      if (signalUrl) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5_000);
          try {
            const res = await fetch(`${signalUrl}/v1/about`, { signal: controller.signal });
            if (res.ok) {
              if (!opts.json) process.stdout.write(`signal: daemon reachable at ${signalUrl}\n`);
            } else {
              warns.push(`signal: daemon returned HTTP ${String(res.status)} on health check`);
            }
          } finally {
            clearTimeout(timer);
          }
        } catch (_err) {
          warns.push(`signal: daemon unreachable at ${signalUrl} — is it running?`);
        }
      }
    }

    if (!env.BRAVE_API_KEY?.trim()) {
      warns.push('tools: web_search disabled (set BRAVE_API_KEY)');
    }

    {
      const requiredDeployTools = ['ssh', 'scp', 'ssh-keygen'];
      const missingDeployTools = requiredDeployTools.filter((tool) => !hasLocalExecutable(tool));
      if (missingDeployTools.length > 0) {
        warns.push(
          `deploy: missing local tools (${missingDeployTools.join(', ')}) required for \`homie deploy\``,
        );
      } else if (!opts.json) {
        process.stdout.write('deploy: local ssh tools available\n');
      }
    }

    const deployStatePath = defaultDeployStatePath(cfg.paths.dataDir);
    try {
      const deployState = await loadDeployState(deployStatePath);
      if (deployState) {
        if (!opts.json) {
          process.stdout.write(`deploy: state detected (${deployStatePath})\n`);
        }
        if (deployState.phase !== 'done') {
          warns.push(
            `deploy: deployment not finalized (phase=${deployState.phase}); run \`homie deploy resume\``,
          );
        } else if (!opts.json) {
          process.stdout.write('deploy: last deployment marked complete\n');
        }
      } else if (cfg.model.provider.kind === 'mpp') {
        warns.push('deploy: no VPS deploy state found yet (run `homie deploy` after funding)');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warns.push(`deploy: could not parse deploy state (${msg})`);
    }
  }

  const result = issues.length ? 'FAIL' : warns.length ? 'WARN' : 'OK';
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          result,
          ...(loaded ? { configPath: loaded.configPath } : {}),
          warnings: warns,
          issues,
        },
        null,
        2,
      )}\n`,
    );
    if (issues.length) process.exit(1);
    return;
  }

  if (warns.length) {
    process.stdout.write('\nWarnings:\n');
    for (const w of warns) process.stdout.write(`- ${w}\n`);
  }
  if (issues.length) {
    process.stderr.write('\nIssues:\n');
    for (const i of issues) process.stderr.write(`- ${i}\n`);
  }

  process.stdout.write(`\nResult: ${result}\n`);
  if (issues.length) process.exit(1);
}
