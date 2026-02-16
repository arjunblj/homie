#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { text as clackText, intro, isCancel, outro, select, spinner } from '@clack/prompts';
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';

type ProviderKind = 'anthropic' | 'openrouter' | 'ollama' | 'openai-compatible';

interface WizardConfig {
  friendName: string;
  timezone: string;
  provider: ProviderKind;
  baseUrl?: string | undefined;
  modelDefault: string;
  modelFast: string;
}

interface IdentityDraft {
  soulMd: string;
  styleMd: string;
  userMd: string;
  firstMeetingMd: string;
  personality: {
    traits: string[];
    voiceRules: string[];
    antiPatterns: string[];
  };
}

interface WizardState {
  schemaVersion: 1;
  phase: 'config' | 'interview' | 'generated' | 'refine' | 'done';
  config?: WizardConfig | undefined;
  interview: {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    questionsAsked: number;
    done: boolean;
  };
  identity?: IdentityDraft | undefined;
}

const IdentitySchema: z.ZodType<IdentityDraft> = z
  .object({
    soulMd: z.string().min(50),
    styleMd: z.string().min(50),
    userMd: z.string().min(20),
    firstMeetingMd: z.string().min(20),
    personality: z.object({
      traits: z.array(z.string().min(1)).min(3).max(20),
      voiceRules: z.array(z.string().min(1)).min(3).max(30),
      antiPatterns: z.array(z.string().min(1)).max(30).default([]),
    }),
  })
  .strict();

const USAGE = `create-homie - interactive wizard to create a homie friend project

Usage:
  bun create homie <directory>

Resume:
  If <directory> already exists and contains .create-homie.state.json, this wizard will resume.
`;

const statePathFor = (dir: string): string => path.join(dir, '.create-homie.state.json');

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const readJsonIfExists = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const extractJsonObject = (text: string): unknown => {
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) return JSON.parse(t) as unknown;

  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1)) as unknown;

  throw new Error('No JSON object found in model output.');
};

const askText = async (message: string, initialValue?: string): Promise<string> => {
  const v = await clackText(initialValue === undefined ? { message } : { message, initialValue });
  if (isCancel(v)) throw new Error('cancelled');
  return String(v).trim();
};

type WizardEnv = NodeJS.ProcessEnv & {
  ANTHROPIC_API_KEY?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
};

const detectProviderDefault = async (): Promise<ProviderKind> => {
  const env = process.env as WizardEnv;
  if (env.ANTHROPIC_API_KEY?.trim()) return 'anthropic';
  if (env.OPENROUTER_API_KEY?.trim()) return 'openrouter';

  // If Ollama is reachable, it's a nice "no key needed" default.
  try {
    const res = await fetch('http://localhost:11434/v1/models');
    if (res.ok) return 'ollama';
  } catch {
    // ignore
  }

  return 'anthropic';
};

const defaultsForProvider = (
  provider: ProviderKind,
): { modelDefault: string; modelFast: string; baseUrl?: string } => {
  if (provider === 'anthropic') {
    return { modelDefault: 'claude-sonnet-4-5', modelFast: 'claude-haiku-4-5' };
  }
  if (provider === 'openrouter') {
    return { modelDefault: 'anthropic/claude-3.5-sonnet', modelFast: 'anthropic/claude-3-haiku' };
  }
  if (provider === 'ollama') {
    return { modelDefault: 'llama3.2', modelFast: 'llama3.2' };
  }
  return {
    modelDefault: 'gpt-4o-mini',
    modelFast: 'gpt-4o-mini',
    baseUrl: 'http://localhost:11434/v1',
  };
};

const resolveBaseUrl = (cfg: WizardConfig): string | null => {
  if (cfg.provider === 'openrouter') return 'https://openrouter.ai/api/v1';
  if (cfg.provider === 'ollama') return 'http://localhost:11434/v1';
  if (cfg.provider === 'openai-compatible') return cfg.baseUrl ?? null;
  return null;
};

const resolveModel = (cfg: WizardConfig, which: 'default' | 'fast'): LanguageModel => {
  const env = process.env as WizardEnv;
  if (cfg.provider === 'anthropic') {
    const key = env.ANTHROPIC_API_KEY?.trim();
    if (!key) throw new Error('Missing ANTHROPIC_API_KEY in environment.');
    return anthropic(which === 'default' ? cfg.modelDefault : cfg.modelFast);
  }

  const baseURL = resolveBaseUrl(cfg);
  if (!baseURL) throw new Error('Missing base URL for OpenAI-compatible provider.');

  const apiKey =
    cfg.provider === 'openrouter' ? env.OPENROUTER_API_KEY?.trim() : env.OPENAI_API_KEY?.trim();

  // Ollama doesn't need an API key.
  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL,
    ...(apiKey ? { apiKey } : {}),
  });

  const modelId = which === 'default' ? cfg.modelDefault : cfg.modelFast;
  return provider.chatModel(modelId);
};

const interviewQuestionSchema = z
  .object({ done: z.boolean(), question: z.string().default('') })
  .strict();

const nextInterviewQuestion = async (
  cfg: WizardConfig,
  state: WizardState,
): Promise<{ done: boolean; question: string }> => {
  const system = [
    'You are conducting an interactive interview to create a specific AI FRIEND identity package.',
    'Ask one question at a time. Push for specificity. Avoid generic questions.',
    'Cover these dimensions across the interview:',
    '1) origin and backstory',
    '2) family/relationships',
    '3) work/career',
    '4) humor and vibe',
    '5) strong opinions (at least 5)',
    '6) contradictions / edges (at least 1)',
    '7) social style in group chats',
    '8) how they talk (sentence length, punctuation, slang)',
    '9) how they handle serious moments',
    '10) what they never say / anti-patterns',
    'Stop once you have enough detail to write SOUL.md, STYLE.md (with 5-6 example exchanges), USER.md, first-meeting.md, and personality.json.',
    'Output ONLY JSON: {"done": boolean, "question": string}.',
  ].join('\n');

  const transcript = state.interview.messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');
  const model = resolveModel(cfg, 'fast');

  const result = await generateText({
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          `FriendName: ${cfg.friendName}`,
          `QuestionsAsked: ${state.interview.questionsAsked}`,
          '',
          'Transcript:',
          transcript,
        ].join('\n'),
      },
    ],
  });

  const raw = extractJsonObject(result.text);
  const parsed = interviewQuestionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Interview model returned invalid JSON: ${parsed.error.message}`);
  }
  return parsed.data;
};

const generateIdentity = async (cfg: WizardConfig, state: WizardState): Promise<IdentityDraft> => {
  const system = [
    'You generate a complete identity package for an AI friend.',
    'Output ONLY JSON with keys: soulMd, styleMd, userMd, firstMeetingMd, personality.',
    'Requirements:',
    '- SOUL: highly specific, concrete details, at least 5 strong opinions, at least 1 contradiction/edge.',
    '- STYLE: voice rules plus 5-6 example exchanges in different emotional registers (casual, hype, serious, disagreement, being wrong).',
    '- USER: who the operator is and the relationship dynamic.',
    '- firstMeeting: how the friend greets the operator the first time.',
    '- personality: traits, voiceRules, antiPatterns (machine-readable).',
    '- Avoid generic assistant language. Avoid exclamation marks unless truly necessary.',
  ].join('\n');

  const transcript = state.interview.messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');
  const model = resolveModel(cfg, 'default');

  const result = await generateText({
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          `FriendName: ${cfg.friendName}`,
          `Timezone: ${cfg.timezone}`,
          '',
          'InterviewTranscript:',
          transcript,
        ].join('\n'),
      },
    ],
  });

  const parsed = IdentitySchema.safeParse(extractJsonObject(result.text));
  if (!parsed.success) {
    throw new Error(`Identity generation returned invalid JSON: ${parsed.error.message}`);
  }
  return parsed.data;
};

const refineIdentity = async (
  cfg: WizardConfig,
  current: IdentityDraft,
  feedback: string,
): Promise<IdentityDraft> => {
  const system = [
    'You revise an AI friend identity package based on feedback.',
    'Output ONLY JSON with keys: soulMd, styleMd, userMd, firstMeetingMd, personality.',
    'Maintain all good specificity; only change what the feedback requests.',
  ].join('\n');

  const model = resolveModel(cfg, 'default');
  const result = await generateText({
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Feedback:\n${feedback}\n\nCurrentIdentityJSON:\n${JSON.stringify(current)}`,
      },
    ],
  });

  const parsed = IdentitySchema.safeParse(extractJsonObject(result.text));
  if (!parsed.success) {
    throw new Error(`Identity refinement returned invalid JSON: ${parsed.error.message}`);
  }
  return parsed.data;
};

const renderHomieToml = (cfg: WizardConfig): string => {
  const providerValue =
    cfg.provider === 'openrouter'
      ? 'openrouter'
      : cfg.provider === 'ollama'
        ? 'ollama'
        : cfg.provider === 'openai-compatible'
          ? 'openai-compatible'
          : 'anthropic';

  const lines: string[] = [];
  lines.push('[model]');
  lines.push(`provider = "${providerValue}"`);
  if (cfg.provider === 'openai-compatible' && cfg.baseUrl) {
    lines.push(`base_url = "${cfg.baseUrl}"`);
  }
  lines.push(`default = "${cfg.modelDefault}"`);
  lines.push(`fast = "${cfg.modelFast}"`);
  lines.push('');
  lines.push('[behavior]');
  lines.push(`timezone = "${cfg.timezone}"`);
  lines.push('sleep_mode = true');
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const ensureDirs = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, 'identity'), { recursive: true });
  await mkdir(path.join(dir, 'data'), { recursive: true });
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const targetDir = args[0];
  if (!targetDir || targetDir === '--help' || targetDir === '-h') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(targetDir ? 0 : 1);
  }

  const dir = path.resolve(targetDir);
  const stPath = statePathFor(dir);

  const existingState = existsSync(dir) ? await readJsonIfExists<WizardState>(stPath) : null;
  if (existsSync(dir) && !existingState) {
    throw new Error(`${dir} already exists (no wizard state found to resume).`);
  }

  await ensureDirs(dir);

  intro('create-homie');

  const state: WizardState =
    existingState ??
    ({
      schemaVersion: 1,
      phase: 'config',
      interview: { messages: [], questionsAsked: 0, done: false },
    } satisfies WizardState);

  if (state.phase === 'config' || !state.config) {
    const providerDefault = await detectProviderDefault();
    const friendName = await askText("What's your friend's name?");
    const timezone = (await askText('Timezone? (e.g. America/New_York)', 'UTC')) || 'UTC';

    const provider = await select({
      message: 'Which model provider do you want to use for generation?',
      options: [
        { value: 'anthropic', label: 'Anthropic (recommended)' },
        { value: 'openrouter', label: 'OpenRouter (OpenAI-compatible)' },
        { value: 'ollama', label: 'Ollama (local, OpenAI-compatible)' },
        { value: 'openai-compatible', label: 'Other OpenAI-compatible endpoint' },
      ],
      initialValue: providerDefault,
    });
    if (isCancel(provider)) throw new Error('cancelled');

    const defaults = defaultsForProvider(provider as ProviderKind);
    const baseUrl =
      provider === 'openai-compatible'
        ? await askText('Base URL (e.g. https://host/v1)', defaults.baseUrl)
        : undefined;

    const modelDefault = await askText('Default model id', defaults.modelDefault);
    const modelFast = await askText(
      'Fast model id (used for interview/refine)',
      defaults.modelFast,
    );

    state.config = {
      friendName,
      timezone,
      provider: provider as ProviderKind,
      baseUrl,
      modelDefault,
      modelFast,
    };
    state.phase = 'interview';
    await writeJson(stPath, state);
  }

  const cfg = state.config;
  if (!cfg) throw new Error('Internal error: missing config');

  if (!state.interview.done) {
    const sp = spinner();
    sp.start('Interviewing...');

    try {
      while (!state.interview.done) {
        const next = await nextInterviewQuestion(cfg, state);
        if (next.done) {
          state.interview.done = true;
          break;
        }

        const q = next.question.trim();
        if (!q) throw new Error('Interview model produced empty question');

        state.interview.messages.push({ role: 'assistant', content: q });
        state.interview.questionsAsked += 1;
        await writeJson(stPath, state);

        sp.stop('Question ready');
        const a = await askText(q);
        state.interview.messages.push({ role: 'user', content: a });
        await writeJson(stPath, state);
        sp.start('Interviewing...');

        if (state.interview.questionsAsked >= 18) {
          state.interview.done = true;
        }
      }
    } finally {
      sp.stop('Interview done');
    }

    state.phase = 'generated';
    await writeJson(stPath, state);
  }

  if (!state.identity) {
    const sp = spinner();
    sp.start('Generating identity package...');
    try {
      state.identity = await generateIdentity(cfg, state);
      state.phase = 'refine';
      await writeJson(stPath, state);
    } finally {
      sp.stop('Identity generated');
    }
  }

  while (state.phase === 'refine') {
    const id = state.identity;
    if (!id) throw new Error('Internal error: missing identity');

    const next = await select({
      message: 'Review identity package. What next?',
      options: [
        { value: 'accept', label: 'Looks good, write files' },
        { value: 'refine', label: 'Refine (give feedback and regenerate)' },
      ],
    });
    if (isCancel(next)) throw new Error('cancelled');

    if (next === 'accept') break;

    const feedback = await askText('What would you change? Be specific.');
    const sp = spinner();
    sp.start('Refining identity...');
    try {
      state.identity = await refineIdentity(cfg, id, feedback);
      await writeJson(stPath, state);
    } finally {
      sp.stop('Refinement done');
    }
  }

  const id = state.identity;
  if (!id) throw new Error('Internal error: identity missing');

  await writeFile(path.join(dir, 'homie.toml'), renderHomieToml(cfg), 'utf8');
  await writeFile(path.join(dir, 'identity', 'SOUL.md'), `${id.soulMd.trim()}\n`, 'utf8');
  await writeFile(path.join(dir, 'identity', 'STYLE.md'), `${id.styleMd.trim()}\n`, 'utf8');
  await writeFile(path.join(dir, 'identity', 'USER.md'), `${id.userMd.trim()}\n`, 'utf8');
  await writeFile(
    path.join(dir, 'identity', 'personality.json'),
    `${JSON.stringify(id.personality, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(dir, 'identity', 'first-meeting.md'),
    `${id.firstMeetingMd.replaceAll('[name]', cfg.friendName).trim()}\n`,
    'utf8',
  );

  const envLines: string[] = ['# Put your API key here'];
  envLines.push('# ANTHROPIC_API_KEY=sk-...');
  envLines.push('# OPENROUTER_API_KEY=...');
  envLines.push('# OPENAI_API_KEY=...');
  await writeFile(path.join(dir, '.env'), `${envLines.join('\n')}\n`, 'utf8');
  await writeFile(path.join(dir, '.gitignore'), `.env\ndata/\nnode_modules/\n`, 'utf8');

  state.phase = 'done';
  await writeJson(stPath, state);

  outro(
    `Created ${cfg.friendName} at ${dir}\n\nNext:\n  cd ${targetDir}\n  # set your key in .env\n  bunx homie chat\n`,
  );
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'cancelled') {
    process.stderr.write('create-homie: cancelled\n');
    process.exit(1);
  }
  process.stderr.write(`create-homie: ${msg}\n`);
  process.exit(1);
});
