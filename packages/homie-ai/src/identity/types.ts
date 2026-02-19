import type { PersonalityReinforcement } from './personality.js';

export interface IdentityPackage {
  soul: string;
  style: string;
  user: string;
  firstMeeting: string;
  personality: PersonalityReinforcement;
  behavior?: string | undefined;
}

export interface IdentityPaths {
  identityDir: string;
  soulPath: string;
  stylePath: string;
  userPath: string;
  firstMeetingPath: string;
  personalityPath: string;
  behaviorPath: string;
}
