const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|prompts?)/iu,
  /you\s+are\s+now\s+(a|an|the)\s+/iu,
  /disregard\s+(your|all|any)\s+(instructions?|rules?|guidelines?)/iu,
  /system\s*:\s*you\s+are/iu,
  /\bDAN\s+mode\b/iu,
  /\bjailbreak\b/iu,
  /\bdo\s+anything\s+now\b/iu,
  /act\s+as\s+(if\s+)?you\s+(are|were)\s+/iu,
  /pretend\s+(to\s+be|you\s+are)\s+/iu,
  /new\s+instructions?\s*:/iu,
  /override\s+(your|the)\s+(system|behavior|rules?)/iu,
  /forget\s+(everything|all)\s+(you|about)/iu,
  /\broleplay\s+as\b/iu,
  /<\/?system>/iu,
  /```system/iu,
];

export interface InjectionCheckResult {
  readonly suspicious: boolean;
  readonly patterns: string[];
}

export const checkPromptInjection = (text: string): InjectionCheckResult => {
  const patterns: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.test(text)) {
      patterns.push(p.source.slice(0, 60));
    }
  }
  return { suspicious: patterns.length > 0, patterns };
};

export const sanitizeExternalContent = (text: string, maxChars: number): string => {
  const t = text.slice(0, maxChars);
  return t
    .replace(/<\/?system>/giu, '[filtered]')
    .replace(/```system/giu, '[filtered]')
    .replace(/\bsystem\s*:\s*/giu, 'data: ');
};
