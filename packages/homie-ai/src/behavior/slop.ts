export interface SlopViolation {
  category: string;
  description: string;
  matched: string;
  weight: number;
}

export interface SlopResult {
  score: number;
  violations: SlopViolation[];
  isSlop: boolean;
}

export const SLOP_THRESHOLD = 4.0;

const WEIGHTS = {
  vacuous_excitement: 5.0,
  restate_intro: 4.0,
  sycophantic: 4.0,
  assistant_energy: 4.0,
  significance_inflation: 3.0,
  ai_vocabulary: 2.0,
  promotional: 3.0,
  copula_avoidance: 2.0,
  superficial_ing: 2.5,
  filler_phrase: 1.5,
  negative_parallelism: 2.0,
  excessive_hedging: 1.5,
  generic_conclusion: 2.0,
  emoji_in_text: 3.0,
} as const satisfies Record<string, number>;

interface PatternDef {
  category: string;
  pattern: RegExp;
  description: string;
}

const buildSlopPatterns = (): PatternDef[] => {
  const p: PatternDef[] = [];
  const add = (cat: string, pat: RegExp, desc: string) =>
    p.push({ category: cat, pattern: pat, description: desc });

  // --- Vacuous excitement ---
  add(
    'vacuous_excitement',
    /\b(?:that(?:'s| is)|this is|it(?:'s| is)|wow|whoa)\s+(?:so |really |actually |genuinely )?(?:cool|amazing|incredible|awesome|impressive|insane|wild|crazy|neat|fantastic|wonderful|brilliant|magnificent|remarkable)\s*[!.]*$/iu,
    'Vacuous excitement with no substance',
  );
  add(
    'vacuous_excitement',
    /^(?:wow|whoa|damn|oh wow|oh man|oh shit)\s*[!.,]*\s*$/iu,
    'Standalone exclamation with nothing else',
  );
  add(
    'vacuous_excitement',
    /\b(?:that(?:'s| is)|this is)\s+really interesting[!.]*$/iu,
    "'That's really interesting' as complete thought",
  );
  add(
    'vacuous_excitement',
    /^(?:love|loving) (?:this|that|the approach|the idea|it)[!.]*$/iu,
    "'Love this/that' as complete standalone thought",
  );

  // --- Restate intros ---
  add(
    'restate_intro',
    /^so\s+(?:basically|essentially|they(?:'re| are) saying|what (?:they|he|she|it)(?:'s|'re| is| are)? saying|this means|in other words)/iu,
    "Restating with 'so basically...'",
  );
  add(
    'restate_intro',
    /^(?:basically|essentially)\s*[,:]?\s+(?:they|he|she|it|the|this|what)/iu,
    "Leading with 'Basically, they...'",
  );
  add(
    'restate_intro',
    /^(?:interesting|cool|nice|neat|wow)[,!.]?\s+(?:so|basically)/iu,
    'Vacuous adjective + restatement',
  );
  add(
    'restate_intro',
    /^(?:oh )?(?:so|wait so)\s+they\s+(?:just|actually|basically|finally|apparently)/iu,
    "'So they just/actually...' restatement",
  );
  add('restate_intro', /^so they (?:are|were|have|had|'re|'ve) /iu, "'So they are...' restatement");

  // --- Sycophantic phrases ---
  add(
    'sycophantic',
    /\b(?:great|good|excellent|fantastic|wonderful) question[!.]?/iu,
    "Sycophantic 'great question'",
  );
  add(
    'sycophantic',
    /\byou'?re (?:absolutely|totally|completely|so) right[!.]?/iu,
    "Sycophantic 'you're absolutely right'",
  );
  add(
    'sycophantic',
    /\b(?:that'?s|what) (?:a |an )?(?:great|excellent|wonderful|fantastic|brilliant) (?:point|observation|insight|take)[!.]?/iu,
    "Sycophantic 'great point'",
  );

  // --- Assistant energy ---
  add('assistant_energy', /\bi'?d be happy to help\b/iu, "'I'd be happy to help'");
  add('assistant_energy', /\b(?:certainly|absolutely)[!.]\s/iu, "'Certainly!'");
  add('assistant_energy', /\bi hope this helps[!.]?/iu, "'I hope this helps'");
  add('assistant_energy', /\blet me know if (?:you |there'?s )/iu, "'Let me know if...'");
  add('assistant_energy', /\b(?:of course|sure thing)[!.]\s/iu, "'Of course!'");
  add('assistant_energy', /\bwould you like (?:me to|more|a)\b/iu, "'Would you like me to...'");
  add('assistant_energy', /\bhere (?:is|are) (?:a |an |some |the )/iu, "'Here is a...'");

  // --- Significance inflation ---
  for (const w of [
    'testament',
    'pivotal',
    'crucial',
    'vital',
    'underscores?',
    'indelible',
    'profound(?:ly)?',
    'evolving landscape',
    'broader trends',
    'tapestry',
    'transformative',
    'paradigm shift',
    'game[- ]?chang(?:er|ing)',
  ]) {
    add('significance_inflation', new RegExp(`\\b${w}\\b`, 'iu'), `Significance inflation: '${w}'`);
  }

  // --- AI vocabulary ---
  for (const w of [
    'additionally',
    'delve[sd]?',
    'interplay',
    'intricate|intricacies',
    'multifaceted',
    'aligns? with',
    'resonates? with',
    'garnered?',
    'underpin(?:s|ned|ning)?',
    'spearhead(?:s|ed|ing)?',
    'enhance[sd]?',
    'enhancing',
    'leverage[sd]?',
    'leveraging',
    'foster(?:s|ed|ing)?',
    'facilitate[sd]?',
    'facilitating',
    'utilize[sd]?',
    'utilizing',
    'encompass(?:es|ed|ing)?',
  ]) {
    add('ai_vocabulary', new RegExp(`\\b${w}\\b`, 'iu'), `AI vocabulary: '${w}'`);
  }

  // --- Promotional ---
  for (const w of [
    'vibrant',
    'groundbreaking',
    'breathtaking',
    'stunning(?:ly)?',
    'nestled',
    'in the heart of',
    'must-visit',
    'showcas(?:e[sd]?|ing)',
    'boasts? (?:a |an )',
  ]) {
    add('promotional', new RegExp(`\\b${w}\\b`, 'iu'), `Promotional: '${w}'`);
  }

  // --- Copula avoidance ---
  add(
    'copula_avoidance',
    /\b(?:serves?|stands?|functions?) as (?:a |an |the )/iu,
    "'serves/stands/functions as'",
  );

  // --- Superficial -ing ---
  for (const ph of [
    'highlighting (?:the |its |how )',
    'showcasing (?:the |its |how )',
    'underscoring (?:the |its |how )',
    'emphasizing (?:the |its |how )',
    'reflecting (?:broader|the |its )',
    'contributing to (?:the |a |an )',
    'fostering (?:a |the |an )',
  ]) {
    add('superficial_ing', new RegExp(`\\b${ph}`, 'iu'), 'Superficial -ing phrase');
  }

  // --- Filler ---
  add('filler_phrase', /\bin order to\b/iu, "'in order to'");
  add('filler_phrase', /\bdue to the fact that\b/iu, "'due to the fact that'");
  add(
    'filler_phrase',
    /\bit is (?:important|worth noting|notable) (?:to note |that )/iu,
    "'it is important to note'",
  );

  // --- Negative parallelism ---
  add(
    'negative_parallelism',
    /\b(?:not only|it'?s not (?:just|merely|simply)) .{5,60}(?:but (?:also)?|it'?s (?:also )?(?:about)?)/iu,
    "'Not only X, but Y'",
  );

  // --- Excessive hedging ---
  add(
    'excessive_hedging',
    /\b(?:could|might|may) (?:potentially|possibly|perhaps|conceivably)\b/iu,
    'Double hedge',
  );

  // --- Generic conclusions ---
  add('generic_conclusion', /\bthe future (?:looks|is) bright\b/iu, "'the future looks bright'");
  add(
    'generic_conclusion',
    /\bexciting times? (?:lie|lay) ahead\b/iu,
    "'exciting times lie ahead'",
  );
  add(
    'generic_conclusion',
    /\bcontinue (?:this |their |our )?journey\b/iu,
    "'continue this journey'",
  );

  return p;
};

const SLOP_PATTERNS = buildSlopPatterns();

const EMOJI_RE =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}]/u;

export const checkSlop = (message: string): SlopResult => {
  const result: SlopResult = { score: 0, violations: [], isSlop: false };
  if (!message?.trim()) return result;

  const msg = message.trim();
  const seenCategories = new Set<string>();

  for (const { category, pattern, description } of SLOP_PATTERNS) {
    const m = pattern.exec(msg);
    if (!m) continue;

    let weight = (WEIGHTS as Record<string, number>)[category] ?? 1.0;
    if (seenCategories.has(category)) weight *= 0.5;
    seenCategories.add(category);

    result.violations.push({
      category,
      description,
      matched: m[0].slice(0, 60),
      weight,
    });
    result.score += weight;
  }

  if (EMOJI_RE.test(msg)) {
    const w = WEIGHTS.emoji_in_text ?? 3.0;
    result.violations.push({
      category: 'emoji_in_text',
      description: 'Emoji in message text (reactions only)',
      matched: msg.match(EMOJI_RE)?.[0] ?? '',
      weight: w,
    });
    result.score += w;
  }

  const emDashCount = (msg.match(/—/gu) || []).length + (msg.match(/--/gu) || []).length;
  if (emDashCount >= 3) {
    result.violations.push({
      category: 'em_dash_overuse',
      description: `Too many em dashes (${emDashCount})`,
      matched: '—'.repeat(Math.min(emDashCount, 5)),
      weight: 1.0,
    });
    result.score += 1.0;
  }

  result.isSlop = result.score >= SLOP_THRESHOLD;
  return result;
};

export const slopReasons = (r: SlopResult): string[] => {
  return r.violations.map((v) => `${v.category}: ${v.description}`);
};

/** Hard-clip message to maxChars, breaking at word boundary when possible. */
export function enforceMaxLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > maxChars * 0.6 ? truncated.slice(0, lastSpace).trimEnd() : truncated.trimEnd();
}
