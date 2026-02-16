import path from 'node:path';

import { fileExists, readTextFile } from '../util/fs.js';
import { parsePersonalityJson } from './personality.js';
import type { IdentityPackage, IdentityPaths } from './types.js';

export const getIdentityPaths = (identityDir: string): IdentityPaths => {
  return {
    identityDir,
    soulPath: path.join(identityDir, 'SOUL.md'),
    stylePath: path.join(identityDir, 'STYLE.md'),
    userPath: path.join(identityDir, 'USER.md'),
    firstMeetingPath: path.join(identityDir, 'first-meeting.md'),
    personalityPath: path.join(identityDir, 'personality.json'),
  };
};

const readRequired = async (filePath: string): Promise<string> => {
  if (!(await fileExists(filePath))) {
    throw new Error(`Missing identity file: ${filePath}`);
  }
  return readTextFile(filePath);
};

export const loadIdentityPackage = async (identityDir: string): Promise<IdentityPackage> => {
  const paths = getIdentityPaths(identityDir);

  const [soul, style, user, firstMeeting, personalityText] = await Promise.all([
    readRequired(paths.soulPath),
    readRequired(paths.stylePath),
    readRequired(paths.userPath),
    readRequired(paths.firstMeetingPath),
    readRequired(paths.personalityPath),
  ]);

  const personality = parsePersonalityJson(personalityText);

  return {
    soul,
    style,
    user,
    firstMeeting,
    personality,
  };
};
