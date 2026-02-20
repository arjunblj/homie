import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { getIdentityPaths } from '../../identity/load.js';
import { probeOllama } from '../../llm/ollama.js';
import { fileExists } from '../../util/fs.js';
import type { GlobalOpts } from '../args.js';

export async function runInitCommand(opts: GlobalOpts): Promise<void> {
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
  await writeIfMissing(idPaths.firstMeetingPath, `Hi. I'm here with you. What's going on today?\n`);
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
  else if (provider === 'openrouter') nextSteps.push('- Set OPENROUTER_API_KEY (see .env.example)');
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
}
