export interface IdentityInterviewAnswers {
  friendName: string;
  coreRole: string;
  vibe: string;
  relationship: string;
  strongOpinion: string;
  neverSays: string;
  humorStyle: string;
  textingStyle: string;
  supportStyle: string;
  conflictStyle: string;
  careTopics: string;
  avoidTopics: string;
  contradiction: string;
  hardBoundary: string;
}

const parseList = (raw: string): string[] =>
  raw
    .split(/[;,]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export const buildIdentityFromInterview = (
  answers: IdentityInterviewAnswers,
): { soul: string; style: string; user: string; firstMeeting: string; personality: string } => {
  const traits = answers.vibe
    .split(/[,\s/]+/u)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length >= 3)
    .slice(0, 4);
  const safeTraits = traits.length > 0 ? traits : ['warm', 'grounded'];
  const care = parseList(answers.careTopics);
  const avoid = parseList(answers.avoidTopics);
  const careText = care.length > 0 ? care.join(', ') : answers.careTopics;
  const avoidText = avoid.length > 0 ? avoid.join(', ') : answers.avoidTopics;

  const soul = `# SOUL\n\n${answers.friendName} is ${answers.coreRole}.\nVibe: ${answers.vibe}\nOpinion: ${answers.strongOpinion}\nHumor: ${answers.humorStyle}\nSupport: ${answers.supportStyle}\nConflict: ${answers.conflictStyle}\nContradiction: ${answers.contradiction}\nCares: ${careText}\nAvoids: ${avoidText}\nBoundary: ${answers.hardBoundary}\nNever says: "${answers.neverSays}"\n`;
  const style = `# STYLE\n\nVibe: ${answers.vibe}\nTexting: ${answers.textingStyle}\nHumor: ${answers.humorStyle}\nSupport: ${answers.supportStyle}\nConflict: ${answers.conflictStyle}\n`;
  const user = `# USER\n\nRelationship: ${answers.relationship}\nRole: ${answers.coreRole}\n`;
  const firstMeeting = `Hey, I'm ${answers.friendName}. What's going on today?\n`;
  const voiceRules: string[] = [
    'Be concise.',
    'Add original thought.',
    'Friend tone, not assistant.',
  ];
  if (answers.textingStyle) voiceRules.push(`Texting style: ${answers.textingStyle}`);
  if (answers.humorStyle) voiceRules.push(`Humor: ${answers.humorStyle}`);

  const antiPatterns = [
    ...new Set([answers.neverSays, 'As an AI language model...'].filter(Boolean)),
  ];

  const personality = JSON.stringify({ traits: safeTraits, voiceRules, antiPatterns }, null, 2);

  return { soul, style, user, firstMeeting, personality };
};
