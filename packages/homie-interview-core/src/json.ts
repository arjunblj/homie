export const extractJsonObject = (text: string): unknown => {
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      // Fall through to brace-tracking extraction.
    }
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (!ch) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== '}' || depth === 0) continue;

    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    const candidate = t.slice(start, i + 1);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      start = -1;
    }
  }

  throw new Error('No JSON object found in model output.');
};
