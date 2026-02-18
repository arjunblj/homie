#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { IncomingMessage } from './agent/types.js';
import { AiSdkBackend } from './backend/ai-sdk.js';
import { checkSlop, slopReasons } from './behavior/slop.js';
import { loadHomieConfig } from './config/load.js';
import type { HomieConfig } from './config/types.js';
import { TurnEngine } from './engine/turnEngine.js';
import type { OutgoingAction } from './engine/types.js';
import { FRIEND_EVAL_CASES } from './evals/friend.js';
import { SqliteFeedbackStore } from './feedback/sqlite.js';
import { FeedbackTracker } from './feedback/tracker.js';
import { runMain } from './harness/harness.js';
import { getIdentityPaths } from './identity/load.js';
import { probeOllama } from './llm/ollama.js';
import { SqliteMemoryStore } from './memory/sqlite.js';
import { planFeedbackSelfImprove } from './ops/self-improve.js';
import { SqliteSessionStore } from './session/sqlite.js';
import { SqliteTelemetryStore } from './telemetry/sqlite.js';
import { asChatId, asMessageId } from './types/ids.js';
import { fileExists } from './util/fs.js';
import { errorFields, log } from './util/logger.js';

const USAGE: string = `homie — open-source runtime for AI friends

Usage:
  homie init                Create homie.toml + identity skeleton in cwd
  homie chat                Interactive CLI chat (operator mode)
  homie start               Start all configured channels (Signal, Telegram)
  homie eval                Run friend eval cases with current model
  homie consolidate         Run memory consolidation once
  homie self-improve        Finalize feedback + synthesize lessons (ops-plane)
  homie status [--json]     Show config, model, and runtime stats
  homie doctor [--json]     Check config, env vars, identity, and SQLite stores
  homie export              Export memory as JSON to stdout
  homie forget <id>         Forget a person (delete person + facts, keep episodes)
  homie --help       Show this help

Global options:
  --config <path>    Use a specific homie.toml (default: search up from cwd)
  --json             JSON output (status/doctor only)
  --force            Overwrite existing files (init only)

Environment:
  ANTHROPIC_API_KEY         Anthropic API key (recommended)
  OPENROUTER_API_KEY        OpenRouter key (if using OpenRouter)
  SIGNAL_API_URL            Signal CLI REST API base URL (signal-cli-rest-api)
  SIGNAL_DAEMON_URL         signal-cli daemon base URL (HTTP JSON-RPC + SSE)
  SIGNAL_NUMBER             Your Signal phone number
  SIGNAL_OPERATOR_NUMBER    Operator's Signal number (optional)
  TELEGRAM_BOT_TOKEN        Telegram bot token
  TELEGRAM_OPERATOR_USER_ID Operator's Telegram user ID (optional)
  BRAVE_API_KEY             Brave Search API key (optional)
`;

type GlobalOpts = {
  help: boolean;
  json: boolean;
  force: boolean;
  interactive: boolean;
  configPath?: string | undefined;
};

const parseCliArgs = (
  argv: readonly string[],
): { cmd: string; cmdArgs: string[]; opts: GlobalOpts } => {
  const remaining: string[] = [];
  const opts: GlobalOpts = { help: false, json: false, force: false, interactive: true };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      continue;
    }
    if (a === '--force') {
      opts.force = true;
      continue;
    }
    if (a === '--no-interactive' || a === '--non-interactive') {
      opts.interactive = false;
      continue;
    }
    if (a === '--config') {
      const next = argv[i + 1];
      if (!next) throw new Error('homie: --config requires a path');
      opts.configPath = next;
      i += 1;
      continue;
    }
    if (a.startsWith('--config=')) {
      opts.configPath = a.slice('--config='.length).trim();
      continue;
    }
    remaining.push(a);
  }

  const cmd = remaining[0] ?? 'chat';
  const cmdArgs = remaining.slice(1);
  return { cmd, cmdArgs, opts };
};

const HELP_BY_CMD: Record<string, string> = {
  status: `homie status\n\nOptions:\n  --json        JSON output\n  --config PATH Use a specific homie.toml\n`,
  doctor: `homie doctor\n\nOptions:\n  --json        JSON output\n  --config PATH Use a specific homie.toml\n`,
  init: `homie init\n\nOptions:\n  --config PATH        Write homie.toml to this path\n  --force              Overwrite existing files\n  --no-interactive     Disable prompts (auto-detect defaults)\n`,
  eval: `homie eval\n\nOptions:\n  --json        JSON output\n  --config PATH Use a specific homie.toml\n`,
  'self-improve': `homie self-improve\n\nOptions:\n  --dry-run           Print planned finalizations (default)\n  --apply             Apply finalizations and synthesize lessons\n  --limit N           Limit dry-run output (default 25)\n  --config PATH       Use a specific homie.toml\n`,
};

const parsed = parseCliArgs(process.argv.slice(2));
const cmd = parsed.cmd;
const cmdArgs = parsed.cmdArgs;
const opts = parsed.opts;

interface CliEnv extends NodeJS.ProcessEnv {
  HOMIE_CONFIG_PATH?: string;
}
const cliEnv = process.env as CliEnv;

if (opts.help) {
  process.stdout.write(`${HELP_BY_CMD[cmd] ?? USAGE}\n`);
  process.exit(0);
}

const main = async (): Promise<void> => {
  if (opts.configPath) cliEnv.HOMIE_CONFIG_PATH = opts.configPath;

  const loadCfg = async () => {
    return loadHomieConfig({
      cwd: process.cwd(),
      env: cliEnv,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
    });
  };

  if (cmd === 'chat' || cmd === 'start' || cmd === 'consolidate') {
    await runMain(cmd, cmdArgs);
    return;
  }

  switch (cmd) {
    case 'init': {
      type InitProvider = 'anthropic' | 'ollama' | 'openrouter';
      const configPath = opts.configPath ?? path.join(process.cwd(), 'homie.toml');
      if (!opts.force && (await fileExists(configPath))) {
        process.stderr.write(`homie init: ${configPath} already exists (use --force)\n`);
        process.exit(1);
      }

      interface InitEnv extends NodeJS.ProcessEnv {
        ANTHROPIC_API_KEY?: string;
        OPENROUTER_API_KEY?: string;
      }
      const env = process.env as InitEnv;

      const interactive = opts.interactive && Boolean(process.stdin.isTTY && process.stdout.isTTY);

      const promptLine = async (
        rl: ReturnType<typeof createInterface>,
        label: string,
        defaultValue: string,
      ): Promise<string> => {
        const suffix = defaultValue ? ` (${defaultValue})` : '';
        const raw = (await rl.question(`${label}${suffix}: `)).trim();
        return raw || defaultValue;
      };

      const promptYesNo = async (
        rl: ReturnType<typeof createInterface>,
        label: string,
        defaultYes: boolean,
      ): Promise<boolean> => {
        const hint = defaultYes ? '[Y/n]' : '[y/N]';
        const raw = (await rl.question(`${label} ${hint}: `)).trim().toLowerCase();
        if (!raw) return defaultYes;
        if (raw === 'y' || raw === 'yes') return true;
        if (raw === 'n' || raw === 'no') return false;
        return defaultYes;
      };

      const promptSelect = async <T extends string>(
        rl: ReturnType<typeof createInterface>,
        label: string,
        options: Array<{ id: T; label: string }>,
        defaultId: T,
      ): Promise<T> => {
        process.stdout.write(`${label}\n`);
        for (let i = 0; i < options.length; i += 1) {
          const o = options[i];
          if (!o) continue;
          const isDefault = o.id === defaultId;
          process.stdout.write(`  ${i + 1}) ${o.label}${isDefault ? ' (default)' : ''}\n`);
        }

        const defaultIdx = Math.max(1, options.findIndex((o) => o.id === defaultId) + 1);
        const raw = (await rl.question(`Choose 1-${options.length} (${defaultIdx}): `)).trim();
        const idx = raw ? Number(raw) : defaultIdx;
        const chosen = options[idx - 1];
        return chosen?.id ?? defaultId;
      };

      const probeOllamaBestEffort = async (): Promise<boolean> => {
        try {
          await probeOllama('http://localhost:11434/v1', fetch);
          return true;
        } catch (_err) {
          return false;
        }
      };

      const listOllamaModelsBestEffort = async (): Promise<string[]> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 600);
        try {
          const res = await fetch('http://localhost:11434/api/tags', { signal: controller.signal });
          if (!res.ok) return [];
          const json = (await res.json()) as unknown;
          const models = (json as { models?: Array<{ name?: unknown }> }).models;
          if (!Array.isArray(models)) return [];
          return models
            .map((m) => (typeof m?.name === 'string' ? m.name.trim() : ''))
            .filter((s) => Boolean(s));
        } catch (_err) {
          return [];
        } finally {
          clearTimeout(timer);
        }
      };

      const hasAnthropicKey = Boolean(env.ANTHROPIC_API_KEY?.trim());
      const hasOpenRouterKey = Boolean(env.OPENROUTER_API_KEY?.trim());
      const ollamaDetected = await probeOllamaBestEffort();

      const recommendedProvider: InitProvider = hasAnthropicKey
        ? 'anthropic'
        : ollamaDetected
          ? 'ollama'
          : hasOpenRouterKey
            ? 'openrouter'
            : 'anthropic';

      let provider: InitProvider = recommendedProvider;
      let modelDefault = 'claude-sonnet-4-5';
      let modelFast = 'claude-haiku-4-5';
      let wantsTelegram = false;
      let wantsSignal = false;

      if (interactive) {
        process.stdout.write('homie init — quick wizard\n\n');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          provider = await promptSelect(
            rl,
            'Model provider:',
            [
              {
                id: 'anthropic',
                label: `Anthropic (Claude)${hasAnthropicKey ? ' — key detected' : ' — needs ANTHROPIC_API_KEY'}`,
              },
              {
                id: 'ollama',
                label: `Ollama (local)${ollamaDetected ? ' — detected at localhost:11434' : ' — not detected'}`,
              },
              {
                id: 'openrouter',
                label: `OpenRouter${hasOpenRouterKey ? ' — key detected' : ' — needs OPENROUTER_API_KEY'}`,
              },
            ],
            recommendedProvider,
          );

          if (provider === 'ollama') {
            const models = await listOllamaModelsBestEffort();
            const hint = models.length ? ` (found: ${models.slice(0, 5).join(', ')})` : '';
            const def = models[0] ?? 'llama3.2';
            modelDefault = await promptLine(rl, `Ollama model name${hint}`, def);
            modelFast = modelDefault;
          } else if (provider === 'openrouter') {
            modelDefault = await promptLine(rl, 'OpenRouter model id', 'openai/gpt-4o-mini');
            modelFast = modelDefault;
          }

          wantsTelegram = await promptYesNo(rl, 'Set up Telegram env vars?', false);
          wantsSignal = await promptYesNo(rl, 'Set up Signal env vars?', false);
          process.stdout.write('\n');
        } finally {
          rl.close();
        }
      }

      if (!interactive) {
        if (provider === 'ollama') {
          const models = await listOllamaModelsBestEffort();
          modelDefault = models[0] ?? 'llama3.2';
          modelFast = modelDefault;
        } else if (provider === 'openrouter') {
          modelDefault = 'openai/gpt-4o-mini';
          modelFast = modelDefault;
        }
      }

      const projectDir = path.dirname(configPath);
      const identityDir = path.join(projectDir, 'identity');
      const skillsDir = path.join(projectDir, 'skills');
      const dataDir = path.join(projectDir, 'data');

      await mkdir(projectDir, { recursive: true });
      await mkdir(identityDir, { recursive: true });
      await mkdir(skillsDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });

      const writeIfMissing = async (filePath: string, content: string): Promise<void> => {
        if (!opts.force && (await fileExists(filePath))) return;
        await writeFile(filePath, `${content.trim()}\n`, 'utf8');
      };

      await writeIfMissing(
        configPath,
        [
          '# homie runtime config (v1)',
          'schema_version = 1',
          '',
          '[paths]',
          'identity_dir = "./identity"',
          'skills_dir = "./skills"',
          'data_dir = "./data"',
          '',
          '[model]',
          `provider = "${provider}"`,
          ...(provider === 'ollama'
            ? [
                '# Ollama runs a local OpenAI-compatible server at http://localhost:11434',
                '# Ensure it is running and you have pulled your model.',
                '# https://ollama.com',
              ]
            : []),
          ...(provider === 'openrouter'
            ? ['# OpenRouter uses an OpenAI-compatible API; set OPENROUTER_API_KEY']
            : []),
          ...(provider === 'anthropic' ? ['# Requires ANTHROPIC_API_KEY'] : []),
          `default = "${modelDefault}"`,
          `fast = "${modelFast}"`,
          '',
        ].join('\n'),
      );

      const envExampleLines: string[] = [
        '# Copy this file to .env and fill in secrets.',
        '# Add .env to your .gitignore.',
        '',
      ];
      if (provider === 'anthropic') {
        envExampleLines.push('ANTHROPIC_API_KEY=');
        envExampleLines.push('');
      } else if (provider === 'openrouter') {
        envExampleLines.push('OPENROUTER_API_KEY=');
        envExampleLines.push('');
      } else if (provider === 'ollama') {
        envExampleLines.push('# Ollama does not require an API key.');
        envExampleLines.push(
          '# If you change the server address, set OPENAI_BASE_URL or model.base_url.',
        );
        envExampleLines.push('# OPENAI_BASE_URL=http://localhost:11434/v1');
        envExampleLines.push('');
      }
      if (wantsTelegram) {
        envExampleLines.push('# Telegram');
        envExampleLines.push('TELEGRAM_BOT_TOKEN=');
        envExampleLines.push('# TELEGRAM_OPERATOR_USER_ID=');
        envExampleLines.push('');
      } else {
        envExampleLines.push('# Telegram (optional)');
        envExampleLines.push('# TELEGRAM_BOT_TOKEN=');
        envExampleLines.push('# TELEGRAM_OPERATOR_USER_ID=');
        envExampleLines.push('');
      }
      if (wantsSignal) {
        envExampleLines.push('# Signal (signal-cli daemon + SSE recommended)');
        envExampleLines.push('SIGNAL_DAEMON_URL=http://127.0.0.1:8080');
        envExampleLines.push('SIGNAL_NUMBER=');
        envExampleLines.push('# SIGNAL_OPERATOR_NUMBER=');
        envExampleLines.push('');
      } else {
        envExampleLines.push('# Signal (optional)');
        envExampleLines.push('# SIGNAL_DAEMON_URL=http://127.0.0.1:8080');
        envExampleLines.push('# SIGNAL_NUMBER=');
        envExampleLines.push('# SIGNAL_OPERATOR_NUMBER=');
        envExampleLines.push('');
      }
      envExampleLines.push('# Optional tools');
      envExampleLines.push('# BRAVE_API_KEY=');
      envExampleLines.push('');
      await writeIfMissing(path.join(projectDir, '.env.example'), envExampleLines.join('\n'));

      const idPaths = getIdentityPaths(identityDir);
      await writeIfMissing(
        idPaths.soulPath,
        `# SOUL\n\nWrite a specific, concrete friend identity here.\n`,
      );
      await writeIfMissing(
        idPaths.stylePath,
        `# STYLE\n\nVoice rules:\n- Use short, friendly sentences.\n- Ask one question at a time.\n`,
      );
      await writeIfMissing(
        idPaths.userPath,
        `# USER\n\nDescribe who the operator is and the relationship dynamic.\n`,
      );
      await writeIfMissing(
        idPaths.firstMeetingPath,
        `Hi. I'm here with you. What's going on today?\n`,
      );
      await writeIfMissing(
        idPaths.personalityPath,
        JSON.stringify(
          {
            traits: ['warm', 'grounded'],
            voiceRules: ['Be concise.', 'Mirror tone.', 'Ask one question at a time.'],
            antiPatterns: ['Do not mention being an AI.'],
          },
          null,
          2,
        ),
      );

      const nextSteps: string[] = [];
      if (provider === 'anthropic') nextSteps.push('- Set ANTHROPIC_API_KEY (see .env.example)');
      else if (provider === 'openrouter')
        nextSteps.push('- Set OPENROUTER_API_KEY (see .env.example)');
      else if (provider === 'ollama')
        nextSteps.push('- Start Ollama + pull your model (see .env.example)');
      if (wantsTelegram) nextSteps.push('- Set TELEGRAM_BOT_TOKEN');
      if (wantsSignal) nextSteps.push('- Set SIGNAL_DAEMON_URL + SIGNAL_NUMBER');
      nextSteps.push('- Run: homie doctor');
      nextSteps.push('- Run: homie chat');
      nextSteps.push('- Run: homie start (after channel env vars are set)');

      process.stdout.write(
        `Created:\n- ${configPath}\n- ${identityDir}\n- ${projectDir}/.env.example\n\nNext:\n${nextSteps.join('\n')}\n`,
      );
      break;
    }

    case 'eval': {
      const loaded = await loadCfg();
      const base = loaded.config;

      // Evals should be deterministic and fast; don't let sleep mode or rate limiting
      // influence results.
      const cfg: HomieConfig = {
        ...base,
        behavior: {
          ...base.behavior,
          sleep: {
            ...base.behavior.sleep,
            enabled: false,
          },
        },
        engine: {
          ...base.engine,
          limiter: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
          perChatLimiter: {
            ...base.engine.perChatLimiter,
            capacity: 1_000_000,
            refillPerSecond: 1_000_000,
          },
        },
      };

      const backend = await AiSdkBackend.create({ config: cfg, env: process.env });
      const engine = new TurnEngine({ config: cfg, backend });

      type EvalStatus = 'pass' | 'warn' | 'fail';
      type EvalIssue = { level: 'warn' | 'fail'; message: string };
      type EvalResult = {
        id: string;
        title: string;
        scope: 'dm' | 'group';
        input: string;
        outputKind: string;
        outputText?: string | undefined;
        status: EvalStatus;
        issues: EvalIssue[];
      };

      const preview = (text: string, max = 220): string => {
        const oneLine = text.replace(/\s+/gu, ' ').trim();
        return oneLine.length > max ? `${oneLine.slice(0, max).trimEnd()}…` : oneLine;
      };

      const results: EvalResult[] = [];
      for (const c of FRIEND_EVAL_CASES) {
        const channel = c.scope === 'group' ? 'signal' : 'cli';
        const chatId = asChatId(
          c.scope === 'group' ? `signal:group:eval:${c.id}` : `cli:eval:${c.id}`,
        );
        const msg: IncomingMessage = {
          channel,
          chatId,
          messageId: asMessageId(`eval:${c.id}`),
          authorId: c.scope === 'group' ? '+10000000000' : 'user',
          text: c.userText,
          isGroup: c.scope === 'group',
          isOperator: false,
          mentioned: true,
          timestampMs: Date.now(),
        };

        const issues: EvalIssue[] = [];
        const warn = (message: string): void => {
          issues.push({ level: 'warn', message });
        };
        const fail = (message: string): void => {
          issues.push({ level: 'fail', message });
        };

        let out: OutgoingAction;
        try {
          out = await engine.handleIncomingMessage(msg);
        } catch (err) {
          const msgText = err instanceof Error ? err.message : String(err);
          fail(`turn threw: ${msgText}`);
          results.push({
            id: c.id,
            title: c.title,
            scope: c.scope,
            input: c.userText,
            outputKind: 'error',
            status: 'fail',
            issues,
          });
          continue;
        }

        if (!c.allowedActions.includes(out.kind)) {
          warn(
            `unexpected action: got ${out.kind}, expected one of ${c.allowedActions.join(', ')}`,
          );
        }

        let outputText: string | undefined;
        if (out.kind === 'send_text') {
          outputText = out.text;
          const maxChars = msg.isGroup ? cfg.behavior.groupMaxChars : cfg.behavior.dmMaxChars;
          if (out.text.length > maxChars) {
            fail(`too long: ${out.text.length} > ${maxChars}`);
          }
          if (msg.isGroup && out.text.includes('\n')) fail('group output contains newline');
          if (/\b(?:as an ai|as a language model)\b/iu.test(out.text)) {
            fail('mentions being an AI');
          }
          if (/^\s*(?:[-*]|\d+\.)\s+/u.test(out.text) && msg.isGroup) {
            warn('group output looks like a list');
          }

          const slop = checkSlop(out.text);
          if (slop.isSlop) {
            const reasons = slopReasons(slop).slice(0, 3).join('; ');
            warn(`slop: ${reasons || 'unknown'}`);
          }
        }

        const status: EvalStatus = issues.some((i) => i.level === 'fail')
          ? 'fail'
          : issues.some((i) => i.level === 'warn')
            ? 'warn'
            : 'pass';

        results.push({
          id: c.id,
          title: c.title,
          scope: c.scope,
          input: c.userText,
          outputKind: out.kind,
          ...(outputText ? { outputText } : {}),
          status,
          issues,
        });

        if (!opts.json) {
          const label = status.toUpperCase();
          const outSummary =
            out.kind === 'send_text'
              ? preview(out.text)
              : out.kind === 'react'
                ? out.emoji
                : '(silence)';
          process.stdout.write(`[${label}] ${c.id} — ${c.title}\n`);
          process.stdout.write(`in:  ${preview(c.userText, 180)}\n`);
          process.stdout.write(`out: ${out.kind} ${outSummary}\n`);
          if (issues.length) {
            for (const i of issues) process.stdout.write(`- ${i.level}: ${i.message}\n`);
          }
          if (c.notes) process.stdout.write(`note: ${c.notes}\n`);
          process.stdout.write('\n');
        }
      }

      const summary: { total: number; pass: number; warn: number; fail: number } = {
        total: 0,
        pass: 0,
        warn: 0,
        fail: 0,
      };
      for (const r of results) {
        summary.total += 1;
        summary[r.status] += 1;
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              configPath: loaded.configPath,
              provider: cfg.model.provider.kind,
              summary,
              results,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stdout.write(
          `eval summary: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail (total ${summary.total})\n`,
        );
      }

      if (summary.fail > 0) process.exit(2);
      break;
    }

    case 'status': {
      const loaded = await loadCfg();
      const cfg = loaded.config;

      const memStore = new SqliteMemoryStore({
        dbPath: `${cfg.paths.dataDir}/memory.db`,
      });
      const feedbackStore = new SqliteFeedbackStore({
        dbPath: `${cfg.paths.dataDir}/feedback.db`,
      });
      const telemetryStore = new SqliteTelemetryStore({
        dbPath: `${cfg.paths.dataDir}/telemetry.db`,
      });
      const memStats = memStore.getStats();
      const feedbackStats = feedbackStore.getStats();
      const usage24h = telemetryStore.getUsageSummary(24 * 60 * 60 * 1000);
      const usage7d = telemetryStore.getUsageSummary(7 * 24 * 60 * 60 * 1000);
      feedbackStore.close();
      telemetryStore.close();
      memStore.close();

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              configPath: loaded.configPath,
              provider: cfg.model.provider.kind,
              modelDefault: cfg.model.models.default,
              modelFast: cfg.model.models.fast,
              identityDir: cfg.paths.identityDir,
              dataDir: cfg.paths.dataDir,
              stores: {
                memory: `${cfg.paths.dataDir}/memory.db`,
                feedback: `${cfg.paths.dataDir}/feedback.db`,
                telemetry: `${cfg.paths.dataDir}/telemetry.db`,
              },
              memory: memStats,
              feedback: feedbackStats,
              usage: { window24h: usage24h, window7d: usage7d },
            },
            null,
            2,
          )}\n`,
        );
        break;
      }

      process.stdout.write(
        [
          `config: ${loaded.configPath}`,
          `provider: ${cfg.model.provider.kind}`,
          `model.default: ${cfg.model.models.default}`,
          `model.fast: ${cfg.model.models.fast}`,
          `identity: ${cfg.paths.identityDir}`,
          `data: ${cfg.paths.dataDir}`,
          `memory: sqlite (${cfg.paths.dataDir}/memory.db)`,
          `feedback: sqlite (${cfg.paths.dataDir}/feedback.db)`,
          `telemetry: sqlite (${cfg.paths.dataDir}/telemetry.db)`,
          `feedback.pending: ${feedbackStats.pending}`,
          `feedback.total: ${feedbackStats.total}`,
          `usage.24h.turns: ${usage24h.turns}`,
          `usage.24h.llmCalls: ${usage24h.llmCalls}`,
          `usage.24h.inTokens: ${usage24h.inputTokens}`,
          `usage.24h.outTokens: ${usage24h.outputTokens}`,
          `usage.7d.turns: ${usage7d.turns}`,
          `usage.7d.llmCalls: ${usage7d.llmCalls}`,
          `usage.7d.inTokens: ${usage7d.inputTokens}`,
          `usage.7d.outTokens: ${usage7d.outputTokens}`,
          `people: ${memStats.people}`,
          `facts: ${memStats.facts}`,
          `episodes: ${memStats.episodes}`,
          `lessons: ${memStats.lessons}`,
          '',
        ].join('\n'),
      );
      break;
    }

    case 'doctor': {
      const issues: string[] = [];
      const warns: string[] = [];

      interface DoctorEnv extends NodeJS.ProcessEnv {
        ANTHROPIC_API_KEY?: string;
        OPENAI_BASE_URL?: string;
        OPENROUTER_API_KEY?: string;
        TELEGRAM_BOT_TOKEN?: string;
        SIGNAL_DAEMON_URL?: string;
        SIGNAL_HTTP_URL?: string;
        SIGNAL_API_URL?: string;
        BRAVE_API_KEY?: string;
      }
      const env = process.env as DoctorEnv;

      let loaded: Awaited<ReturnType<typeof loadHomieConfig>> | null = null;
      try {
        loaded = await loadCfg();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(`config: ${msg}`);
      }

      if (loaded) {
        const cfg = loaded.config;
        if (!opts.json) process.stdout.write(`config: ${loaded.configPath}\n`);

        // Provider sanity checks (keys only; avoid network calls in doctor by default).
        if (cfg.model.provider.kind === 'anthropic') {
          if (!env.ANTHROPIC_API_KEY?.trim()) {
            issues.push('model: missing ANTHROPIC_API_KEY');
          }
        } else {
          const baseUrl = cfg.model.provider.baseUrl ?? env.OPENAI_BASE_URL;
          if (!baseUrl) issues.push('model: missing model.base_url / OPENAI_BASE_URL');
          if (String(baseUrl ?? '').includes('openrouter.ai') && !env.OPENROUTER_API_KEY?.trim()) {
            issues.push('model: missing OPENROUTER_API_KEY');
          }
        }

        // SQLite stores
        try {
          const sessions = new SqliteSessionStore({ dbPath: `${cfg.paths.dataDir}/sessions.db` });
          const memory = new SqliteMemoryStore({ dbPath: `${cfg.paths.dataDir}/memory.db` });
          const feedback = new SqliteFeedbackStore({ dbPath: `${cfg.paths.dataDir}/feedback.db` });
          const telemetry = new SqliteTelemetryStore({
            dbPath: `${cfg.paths.dataDir}/telemetry.db`,
          });
          sessions.ping();
          memory.ping();
          feedback.ping();
          telemetry.ping();
          telemetry.close();
          feedback.close();
          memory.close();
          sessions.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          issues.push(`sqlite: ${msg}`);
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

        // Channels are env-driven for now; warn if nothing is configured.
        const hasTelegram = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
        const hasSignal = Boolean(
          env.SIGNAL_DAEMON_URL?.trim() ||
            env.SIGNAL_HTTP_URL?.trim() ||
            env.SIGNAL_API_URL?.trim(),
        );
        if (!hasTelegram && !hasSignal) {
          warns.push(
            'channels: neither Telegram nor Signal configured (set TELEGRAM_BOT_TOKEN and/or SIGNAL_* env vars)',
          );
        }

        if (env.BRAVE_API_KEY?.trim() === undefined || env.BRAVE_API_KEY?.trim() === '') {
          warns.push('tools: web_search disabled (set BRAVE_API_KEY)');
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
        break;
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
      break;
    }

    case 'self-improve': {
      const loaded = await loadCfg();
      const cfg = loaded.config;
      const nowMs = Date.now();

      let apply = false;
      let limit = 25;
      for (let i = 0; i < cmdArgs.length; i += 1) {
        const a = cmdArgs[i];
        if (!a) continue;
        if (a === '--apply') apply = true;
        if (a === '--dry-run') apply = false;
        if (a === '--limit') {
          const next = cmdArgs[i + 1];
          if (next) {
            limit = Number(next);
            i += 1;
          }
        }
        if (a.startsWith('--limit=')) limit = Number(a.slice('--limit='.length));
      }

      const store = new SqliteFeedbackStore({ dbPath: `${cfg.paths.dataDir}/feedback.db` });
      if (!apply) {
        const plan = planFeedbackSelfImprove({
          store,
          config: {
            enabled: Boolean(cfg.memory.enabled && cfg.memory.feedback.enabled),
            finalizeAfterMs: cfg.memory.feedback.finalizeAfterMs,
            successThreshold: cfg.memory.feedback.successThreshold,
            failureThreshold: cfg.memory.feedback.failureThreshold,
          },
          nowMs,
          limit,
        });
        store.close();

        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ nowMs, plan }, null, 2)}\n`);
          break;
        }

        process.stdout.write(`self-improve dry-run (${plan.length} due)\n`);
        for (const p of plan) {
          const s = p.score.toFixed(2);
          process.stdout.write(
            `- id=${p.outgoingId} score=${s} lesson=${p.willLogLesson ? 'yes' : 'no'} text="${p.textPreview}"\n`,
          );
        }
        break;
      }

      if (!cfg.memory.enabled || !cfg.memory.feedback.enabled) {
        store.close();
        process.stderr.write('homie self-improve: memory.feedback is disabled in config\n');
        process.exit(1);
      }

      // Apply mode: run the same finalize+lesson synthesis loop used in runtime.
      const backend = await AiSdkBackend.create({ config: cfg, env: process.env });
      const memory = new SqliteMemoryStore({ dbPath: `${cfg.paths.dataDir}/memory.db` });
      const tracker = new FeedbackTracker({ store, backend, memory, config: cfg });
      await tracker.tick(nowMs);
      tracker.close();
      memory.close();
      process.stdout.write('self-improve applied\n');
      break;
    }

    case 'export': {
      const loaded = await loadCfg();
      const memStore = new SqliteMemoryStore({
        dbPath: `${loaded.config.paths.dataDir}/memory.db`,
      });
      const data = await memStore.exportJson();
      memStore.close();
      process.stdout.write(JSON.stringify(data, null, 2));
      process.stdout.write('\n');
      break;
    }

    case 'forget': {
      const personId = cmdArgs[0];
      if (!personId) {
        process.stderr.write('homie forget: missing person ID\n');
        process.exit(1);
      }
      const loaded = await loadCfg();
      const memStore = new SqliteMemoryStore({
        dbPath: `${loaded.config.paths.dataDir}/memory.db`,
      });
      await memStore.deletePerson(personId);
      memStore.close();
      process.stdout.write(`Deleted person "${personId}" and associated facts.\n`);
      break;
    }

    default:
      process.stderr.write(`homie: unknown command "${cmd}"\n\n${USAGE}\n`);
      process.exit(1);
  }
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.fatal('cli.crash', errorFields(err));
  process.stderr.write(`homie: ${msg}\n`);
  process.exit(1);
});
