import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { fileExists, readTextFile } from '../util/fs.js';
import { parsePersonalityJson } from './personality.js';
import type { IdentityPackage, IdentityPaths } from './types.js';

const assertResolvedWithinDir = (
  dirRealPath: string,
  fileRealPath: string,
  label: string,
): void => {
  const rel = path.relative(dirRealPath, fileRealPath);
  if (rel === '' || rel === '.') return;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Identity file "${label}" must resolve within identityDir (${dirRealPath})`);
  }
};

export const getIdentityPaths = (identityDir: string): IdentityPaths => {
  return {
    identityDir,
    soulPath: path.join(identityDir, 'SOUL.md'),
    stylePath: path.join(identityDir, 'STYLE.md'),
    userPath: path.join(identityDir, 'USER.md'),
    firstMeetingPath: path.join(identityDir, 'first-meeting.md'),
    personalityPath: path.join(identityDir, 'personality.json'),
    behaviorPath: path.join(identityDir, 'BEHAVIOR.md'),
    agentsPath: path.join(identityDir, 'AGENTS.md'),
    examplesPath: path.join(identityDir, 'EXAMPLES.md'),
  };
};

const readRequired = async (
  identityDirRealPath: string,
  filePath: string,
  label: string,
): Promise<string> => {
  if (!(await fileExists(filePath))) {
    throw new Error(`Missing identity file "${label}" (expected ${filePath})`);
  }
  const fileRealPath = await realpath(filePath);
  assertResolvedWithinDir(identityDirRealPath, fileRealPath, label);
  return readTextFile(filePath);
};

const readOptional = async (
  identityDirRealPath: string,
  filePath: string,
  label: string,
): Promise<string | undefined> => {
  if (!(await fileExists(filePath))) return undefined;
  const fileRealPath = await realpath(filePath);
  assertResolvedWithinDir(identityDirRealPath, fileRealPath, label);
  return await readTextFile(filePath);
};

export const loadIdentityPackage = async (identityDir: string): Promise<IdentityPackage> => {
  const identityDirRealPath = await realpath(identityDir);
  const paths = getIdentityPaths(identityDirRealPath);

  const [soul, style, user, firstMeeting, personalityText] = await Promise.all([
    readRequired(identityDirRealPath, paths.soulPath, 'SOUL.md'),
    readRequired(identityDirRealPath, paths.stylePath, 'STYLE.md'),
    readRequired(identityDirRealPath, paths.userPath, 'USER.md'),
    readRequired(identityDirRealPath, paths.firstMeetingPath, 'first-meeting.md'),
    readRequired(identityDirRealPath, paths.personalityPath, 'personality.json'),
  ]);

  const personality = parsePersonalityJson(personalityText);

  const [behavior, agentsDoc, examplesDoc] = await Promise.all([
    readOptional(identityDirRealPath, paths.behaviorPath, 'BEHAVIOR.md'),
    readOptional(identityDirRealPath, paths.agentsPath, 'AGENTS.md'),
    readOptional(identityDirRealPath, paths.examplesPath, 'EXAMPLES.md'),
  ]);

  return {
    soul,
    style,
    user,
    firstMeeting,
    personality,
    ...(behavior ? { behavior } : {}),
    ...(agentsDoc ? { agentsDoc } : {}),
    ...(examplesDoc ? { examplesDoc } : {}),
  };
};
