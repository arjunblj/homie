import { z } from 'zod';

export interface IdentityDraft {
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

export const IdentitySchema: z.ZodType<IdentityDraft> = z.object({
  soulMd: z.string().min(50),
  styleMd: z.string().min(50),
  userMd: z.string().min(20),
  firstMeetingMd: z.string().min(20),
  personality: z.object({
    traits: z.array(z.string().min(1)).min(3).max(20),
    voiceRules: z.array(z.string().min(1)).min(3).max(30),
    antiPatterns: z.array(z.string().min(1)).max(30).default([]),
  }),
});

export interface InterviewQuestion {
  done: boolean;
  question: string;
}

export const interviewQuestionSchema: z.ZodType<InterviewQuestion> = z.object({
  done: z.boolean(),
  question: z.string().default(''),
});
