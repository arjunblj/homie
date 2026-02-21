import { z } from 'zod';

export interface IdentityDraft {
  soulMd: string;
  styleMd: string;
  userMd: string;
  firstMeetingMd: string;
  operatorProfile?:
    | {
        relationshipSummary?: string | undefined;
        biographyProfile?: string | undefined;
        technicalProfile?: string | undefined;
      }
    | undefined;
  contradictionMap?: string[] | undefined;
  personality: {
    traits: string[];
    voiceRules: string[];
    antiPatterns: string[];
  };
}

const PersonalitySchema = z
  .object({
    traits: z.array(z.string().min(1)).min(3).max(20),
    voiceRules: z.array(z.string().min(1)).min(3).max(30),
    antiPatterns: z.array(z.string().min(1)).max(30).default([]),
  })
  .strict();

export const IdentitySchema: z.ZodType<IdentityDraft> = z
  .object({
    soulMd: z.string().min(50),
    styleMd: z.string().min(50),
    userMd: z.string().min(20),
    firstMeetingMd: z.string().min(20),
    operatorProfile: z
      .object({
        relationshipSummary: z.string().min(1).optional(),
        biographyProfile: z.string().min(1).optional(),
        technicalProfile: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    contradictionMap: z.array(z.string().min(1)).max(10).optional(),
    personality: PersonalitySchema,
  })
  .strict();

export interface InterviewQuestion {
  done: boolean;
  question: string;
}

const InterviewQuestionSchemaBase = z
  .object({
    done: z.boolean(),
    question: z.string().default(''),
  })
  .strict();

export const interviewQuestionSchema: z.ZodType<InterviewQuestion> =
  InterviewQuestionSchemaBase.superRefine((value, ctx) => {
    if (!value.done && value.question.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['question'],
        message: 'question is required when done=false',
      });
    }
  });
