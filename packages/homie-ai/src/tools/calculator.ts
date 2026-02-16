import { z } from 'zod';
import { defineTool } from './define.js';

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const tokenize = (expr: string): Token[] => {
  const s = expr.trim();
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (!c) break;
    if (c === ' ' || c === '\t' || c === '\n') {
      i += 1;
      continue;
    }
    if (c === '(') {
      out.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (c === ')') {
      out.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      out.push({ kind: 'op', value: c });
      i += 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i + 1;
      while (j < s.length && /[0-9.]/u.test(s[j] ?? '')) j += 1;
      const raw = s.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Invalid number: ${raw}`);
      out.push({ kind: 'num', value });
      i = j;
      continue;
    }
    throw new Error(`Invalid character: ${c}`);
  }
  return out;
};

const precedence = (op: Token & { kind: 'op' }): number => {
  return op.value === '*' || op.value === '/' ? 2 : 1;
};

const toRpn = (tokens: Token[]): Token[] => {
  const out: Token[] = [];
  const stack: Token[] = [];

  for (const t of tokens) {
    if (t.kind === 'num') {
      out.push(t);
      continue;
    }
    if (t.kind === 'op') {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'op') break;
        if (precedence(top) < precedence(t)) break;
        out.push(stack.pop() as Token);
      }
      stack.push(t);
      continue;
    }
    if (t.kind === 'lparen') {
      stack.push(t);
      continue;
    }
    if (t.kind === 'rparen') {
      while (stack.length) {
        const top = stack.pop();
        if (!top) break;
        if (top.kind === 'lparen') break;
        out.push(top);
      }
    }
  }

  while (stack.length) out.push(stack.pop() as Token);
  return out;
};

const evalRpn = (tokens: Token[]): number => {
  const stack: number[] = [];
  for (const t of tokens) {
    if (t.kind === 'num') {
      stack.push(t.value);
      continue;
    }
    if (t.kind === 'op') {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new Error('Invalid expression');
      if (t.value === '+') stack.push(a + b);
      if (t.value === '-') stack.push(a - b);
      if (t.value === '*') stack.push(a * b);
      if (t.value === '/') stack.push(a / b);
    }
  }
  if (stack.length !== 1) throw new Error('Invalid expression');
  const v = stack.at(0);
  if (v === undefined) throw new Error('Invalid expression');
  if (!Number.isFinite(v)) throw new Error('Result is not finite');
  return v;
};

const CalculatorInputSchema = z.object({
  expression: z.string().min(1),
});

export const calculatorTool = defineTool({
  name: 'calculator',
  tier: 'safe',
  description: 'Evaluate a basic arithmetic expression (+ - * / parentheses).',
  inputSchema: CalculatorInputSchema,
  execute: async ({ expression }) => {
    const tokens = tokenize(expression);
    const rpn = toRpn(tokens);
    const value = evalRpn(rpn);
    return { value };
  },
});
