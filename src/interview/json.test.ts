import { describe, expect, test } from 'bun:test';
import { extractJsonObject } from './json.js';

describe('extractJsonObject', () => {
  test('extracts valid json without padding', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  test('extracts json with markdown code blocks', () => {
    expect(
      extractJsonObject(`Here is the json:
\`\`\`json
{"done": true, "question": "what is next?"}
\`\`\`
Hope it helps!`),
    ).toEqual({ done: true, question: 'what is next?' });
  });

  test('handles braces inside JSON strings', () => {
    expect(
      extractJsonObject(
        'preface {"done":false,"question":"contains {braces} in text","meta":{"ok":true}} trailer',
      ),
    ).toEqual({
      done: false,
      question: 'contains {braces} in text',
      meta: { ok: true },
    });
  });

  test('throws if no json object found', () => {
    expect(() => extractJsonObject('no json here')).toThrow('No JSON object found');
  });
});
