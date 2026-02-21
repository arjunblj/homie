import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IdentityPaths } from '../../identity/types.js';
import type { IdentityDraft } from '../../interview/schemas.js';
import type { InitProvider } from '../../llm/detect.js';
import { fileExists } from '../../util/fs.js';
import { buildEnvExampleLines, buildInitConfigToml } from './initTemplates.js';

export interface WriteInitArtifactsOptions {
  configPath: string;
  projectDir: string;
  identityDir: string;
  skillsDir: string;
  dataDir: string;
  envPath: string;
  idPaths: IdentityPaths;
  shouldWriteConfig: boolean;
  provider: InitProvider;
  modelDefault: string;
  modelFast: string;
  wantsTelegram: boolean;
  wantsSignal: boolean;
  identityDraft: IdentityDraft | null;
  overwriteIdentity: boolean;
}

export const writeInitArtifacts = async (opts: WriteInitArtifactsOptions): Promise<void> => {
  await Promise.all([
    mkdir(opts.identityDir, { recursive: true }),
    mkdir(opts.skillsDir, { recursive: true }),
    mkdir(opts.dataDir, { recursive: true }),
  ]);

  const writeManaged = async (
    filePath: string,
    content: string,
    overwrite: boolean,
  ): Promise<void> => {
    if (!overwrite && (await fileExists(filePath))) return;
    await writeFile(filePath, `${content.trim()}\n`, 'utf8');
  };

  if (opts.shouldWriteConfig) {
    await writeManaged(
      opts.configPath,
      buildInitConfigToml(opts.provider, opts.modelDefault, opts.modelFast),
      true,
    );
  }

  const envExampleLines = buildEnvExampleLines(opts.wantsTelegram, opts.wantsSignal);
  await writeManaged(
    path.join(opts.projectDir, '.env.example'),
    envExampleLines.join('\n'),
    opts.shouldWriteConfig,
  );

  if (!(await fileExists(opts.envPath))) {
    await writeFile(opts.envPath, envExampleLines.join('\n'), 'utf8');
  }

  const identityDraft = opts.identityDraft ?? {
    soulMd: '# SOUL\n\nYou are a close friend. Stay warm, honest, and specific.',
    styleMd: '# STYLE\n\nUse concise, natural language. Avoid assistant tone.',
    userMd: '# USER\n\nDescribe the person you are talking to here.',
    firstMeetingMd: 'Hey, good to meet you. What should I call you?',
    personality: {
      traits: ['warm', 'grounded', 'direct'],
      voiceRules: ['be concise', 'avoid AI framing', 'speak like a real friend'],
      antiPatterns: ['As an AI language model...'],
    },
  };

  await Promise.all([
    writeManaged(opts.idPaths.soulPath, identityDraft.soulMd, opts.overwriteIdentity),
    writeManaged(opts.idPaths.stylePath, identityDraft.styleMd, opts.overwriteIdentity),
    writeManaged(opts.idPaths.userPath, identityDraft.userMd, opts.overwriteIdentity),
    writeManaged(
      opts.idPaths.firstMeetingPath,
      identityDraft.firstMeetingMd,
      opts.overwriteIdentity,
    ),
    writeManaged(
      opts.idPaths.personalityPath,
      JSON.stringify(identityDraft.personality, null, 2),
      opts.overwriteIdentity,
    ),
  ]);
};
