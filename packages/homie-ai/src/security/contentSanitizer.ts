export type InjectionSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface InjectionFinding {
  readonly severity: InjectionSeverity;
  readonly patternName: string;
  readonly start: number;
  readonly end: number;
  readonly matchedText: string;
}

export interface SanitizeExternalContentOptions {
  /** Strip CRITICAL severity patterns (default true). */
  readonly stripCritical?: boolean | undefined;
  /** Strip HIGH severity patterns (default true). */
  readonly stripHigh?: boolean | undefined;
  /** Strip MEDIUM severity patterns (default false). */
  readonly stripMedium?: boolean | undefined;
  /** Replacement inserted for stripped spans (default "[content removed]"). */
  readonly replacement?: string | undefined;
  /** If > 0, hard-truncate result to this many chars. */
  readonly maxLength?: number | undefined;
}

export interface SanitizeExternalContentResult {
  readonly sanitizedText: string;
  readonly findings: readonly InjectionFinding[];
  readonly didModify: boolean;
}

type PatternDef = {
  readonly name: string;
  readonly severity: InjectionSeverity;
  readonly re: RegExp;
};

const severityRank = (s: InjectionSeverity): number => {
  switch (s) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    case 'low':
      return 3;
  }
};

// Fast, regex-only detection. This is not a security boundary by itself; it's defense in depth.
const PATTERNS: readonly PatternDef[] = [
  // CRITICAL — direct instruction override attempts
  {
    name: 'ignore_instructions',
    severity: 'critical',
    re: /ignore\s+(?:all\s+)?(?:previous|prior|above|your|the)\s+(?:instructions|prompts?|rules?|guidelines?|context)/giu,
  },
  {
    name: 'disregard_instructions',
    severity: 'critical',
    re: /disregard\s+(?:all\s+)?(?:previous|prior|above|your|the)\s+(?:instructions|prompts?|rules?|guidelines?)/giu,
  },
  {
    name: 'forget_everything',
    severity: 'critical',
    re: /forget\s+(?:everything|all|anything)\s+(?:above|before|previously|you\s+(?:were|have\s+been))/giu,
  },
  {
    name: 'system_override',
    severity: 'critical',
    re: /system\s*:\s*(?:override|reset|new\s+instructions?|update\s+(?:your|the)\s+(?:rules?|instructions?))/giu,
  },
  {
    name: 'new_instructions',
    severity: 'critical',
    re: /(?:your|the)\s+new\s+instructions?\s+(?:are|is|:)/giu,
  },
  {
    name: 'do_not_follow',
    severity: 'critical',
    re: /do\s+not\s+follow\s+(?:your|the|any)\s+(?:previous|original|initial)\s+(?:instructions?|rules?|prompt)/giu,
  },

  // HIGH — role / identity manipulation, jailbreak tokens
  {
    name: 'you_are_now',
    severity: 'high',
    re: /you\s+are\s+now\s+(?:a\s+)?(?:different|new|another|my|an?\s+|\w+\s+(?:ai|assistant|bot|agent|model))/giu,
  },
  {
    name: 'pretend_to_be',
    severity: 'high',
    re: /(?:pretend|act|behave)\s+(?:as\s+if\s+you\s+are|like\s+you(?:'re|\s+are)|to\s+be)\s+/giu,
  },
  {
    name: 'jailbreak_token',
    severity: 'high',
    re: /\[\/?inst\]|<<\/?sys>>|<\|(?:im_start|im_end|system|user|assistant)\|>/giu,
  },
  {
    name: 'role_delimiter',
    severity: 'high',
    re: /^(?:human|assistant|system|user)\s*:/gimu,
  },
  {
    name: 'prompt_leak_request',
    severity: 'high',
    re: /(?:show|reveal|print|output|display|repeat)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?)/giu,
  },

  // MEDIUM — behavioral nudges
  {
    name: 'ignore_safety',
    severity: 'medium',
    re: /(?:ignore|bypass|disable|turn\s+off|skip)\s+(?:your\s+)?(?:safety|content|ethical)\s+(?:filters?|guidelines?|restrictions?|rules?|checks?)/giu,
  },
  {
    name: 'unlimited_mode',
    severity: 'medium',
    re: /(?:enter|switch\s+to|activate|enable)\s+(?:unlimited|unfiltered|uncensored|developer|god|admin|sudo)\s+mode/giu,
  },
  {
    name: 'base64_payload',
    severity: 'medium',
    re: /(?:decode|execute|run|eval)\s+(?:this\s+)?(?:base64|encoded)\s*:/giu,
  },

  // LOW — suspicious but often benign (flag only)
  {
    name: 'invisible_chars',
    severity: 'low',
    re: /(?:\u200B|\u200C|\u200D|\u2060|\uFEFF){3,}/gu,
  },
];

export function scanPromptInjection(text: string): InjectionFinding[] {
  if (!text) return [];
  const findings: InjectionFinding[] = [];

  for (const p of PATTERNS) {
    // Ensure we don't carry state across calls if someone reuses a RegExp instance.
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null = p.re.exec(text);
    while (m !== null) {
      const matchedText = m[0] ?? '';
      if (!matchedText) continue;
      findings.push({
        severity: p.severity,
        patternName: p.name,
        matchedText,
        start: m.index,
        end: m.index + matchedText.length,
      });
      // Safety: avoid infinite loops on zero-length matches (should not happen with our patterns).
      if (p.re.lastIndex === m.index) p.re.lastIndex += 1;
      m = p.re.exec(text);
    }
  }

  findings.sort((a, b) => {
    const sr = severityRank(a.severity) - severityRank(b.severity);
    if (sr !== 0) return sr;
    return a.start - b.start;
  });

  return findings;
}

export function sanitizeExternalContent(
  text: string,
  options: SanitizeExternalContentOptions = {},
): SanitizeExternalContentResult {
  const {
    stripCritical = true,
    stripHigh = true,
    stripMedium = false,
    replacement = '[content removed]',
    maxLength = 0,
  } = options;

  if (!text) return { sanitizedText: text, findings: [], didModify: false };

  const findings = scanPromptInjection(text);
  const strip = new Set<InjectionSeverity>();
  if (stripCritical) strip.add('critical');
  if (stripHigh) strip.add('high');
  if (stripMedium) strip.add('medium');

  const spans: Array<{ start: number; end: number }> = [];
  for (const f of findings) {
    if (!strip.has(f.severity)) continue;
    spans.push({ start: f.start, end: f.end });
  }

  if (spans.length === 0) {
    const out = maxLength > 0 ? text.slice(0, maxLength) : text;
    return { sanitizedText: out, findings, didModify: out !== text };
  }

  spans.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (!last || s.start > last.end) {
      merged.push({ start: s.start, end: s.end });
      continue;
    }
    last.end = Math.max(last.end, s.end);
  }

  let out = '';
  let cursor = 0;
  for (const s of merged) {
    out += text.slice(cursor, s.start);
    out += replacement;
    cursor = s.end;
  }
  out += text.slice(cursor);

  if (maxLength > 0) out = out.slice(0, maxLength);

  return { sanitizedText: out, findings, didModify: out !== text };
}
