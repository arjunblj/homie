import { z } from 'zod';

export interface PersonalityReinforcement {
  traits: string[];
  voiceRules: string[];
  antiPatterns: string[];
}

export const PersonalityJsonSchema: z.ZodType<PersonalityReinforcement> = z.object({
  traits: z.array(z.string().min(1)).min(1).max(20),
  voiceRules: z.array(z.string().min(1)).min(1).max(30),
  antiPatterns: z.array(z.string().min(1)).max(30).default([]),
});

export const parsePersonalityJson = (jsonText: string): PersonalityReinforcement => {
  const unknown = JSON.parse(jsonText) as unknown;
  const parsed = PersonalityJsonSchema.safeParse(unknown);
  if (!parsed.success) {
    throw new Error(`Invalid personality.json: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const formatPersonaReminder = (p: PersonalityReinforcement): string => {
  // Keep this short: it's intended to be re-injected during compaction.
  const traits = p.traits.join(', ');
  const voice = p.voiceRules.map((r) => `- ${r}`).join('\n');
  const anti = p.antiPatterns.length
    ? `\nAnti-patterns:\n${p.antiPatterns.map((r) => `- ${r}`).join('\n')}`
    : '';

  return `Traits: ${traits}\n\nVoice rules:\n${voice}${anti}`.trim();
};
