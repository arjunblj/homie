import type { IncomingMessage } from '../../agent/types.js';
import { createBackend } from '../../backend/factory.js';
import { checkSlop, slopReasons } from '../../behavior/slop.js';
import type { LoadedHomieConfig } from '../../config/load.js';
import type { HomieConfig } from '../../config/types.js';
import { MessageAccumulator, ZERO_DEBOUNCE_CONFIG } from '../../engine/accumulator.js';
import { TurnEngine } from '../../engine/turnEngine.js';
import type { OutgoingAction } from '../../engine/types.js';
import { FRIEND_EVAL_CASES } from '../../evals/friend.js';
import { asChatId, asMessageId } from '../../types/ids.js';
import type { GlobalOpts } from '../args.js';

const EVAL_TURN_TIMEOUT_MS = 120_000;

export const runTurnWithTimeout = async (
  engine: Pick<TurnEngine, 'handleIncomingMessage'>,
  msg: IncomingMessage,
  timeoutMs = EVAL_TURN_TIMEOUT_MS,
): Promise<OutgoingAction> => {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const timeoutMessage = `eval turn timed out after ${timeoutSeconds}s`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);

  try {
    const out = await engine.handleIncomingMessage(msg, undefined, { signal: controller.signal });
    if (timedOut) throw new Error(timeoutMessage);
    return out;
  } catch (err) {
    if (timedOut && !(err instanceof Error && err.message.includes('timed out'))) {
      throw new Error(timeoutMessage);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

export async function runEvalCommand(
  opts: GlobalOpts,
  loadCfg: () => Promise<LoadedHomieConfig>,
): Promise<void> {
  const loaded = await loadCfg();
  const base = loaded.config;

  // Evals should be deterministic and fast; don't let sleep mode or rate limiting
  // influence results.
  const cfg: HomieConfig = {
    ...base,
    behavior: {
      ...base.behavior,
      sleep: {
        ...base.behavior.sleep,
        enabled: false,
      },
      // Evals should not pay real-world "human" delays.
      minDelayMs: 0,
      maxDelayMs: 0,
    },
    engine: {
      ...base.engine,
      limiter: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
      perChatLimiter: {
        ...base.engine.perChatLimiter,
        capacity: 1_000_000,
        refillPerSecond: 1_000_000,
      },
    },
  };

  const { backend } = await createBackend({ config: cfg, env: process.env });
  const engine = new TurnEngine({
    config: cfg,
    backend,
    // Evals should not pay real debounce delays.
    accumulator: new MessageAccumulator(ZERO_DEBOUNCE_CONFIG),
  });

  type EvalStatus = 'pass' | 'warn' | 'fail';
  type EvalIssue = { level: 'warn' | 'fail'; message: string };
  type EvalResult = {
    id: string;
    title: string;
    scope: 'dm' | 'group';
    input: string;
    outputKind: string;
    outputText?: string | undefined;
    status: EvalStatus;
    issues: EvalIssue[];
  };

  const preview = (text: string, max = 220): string => {
    const oneLine = text.replace(/\s+/gu, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max).trimEnd()}…` : oneLine;
  };

  const results: EvalResult[] = [];
  for (const c of FRIEND_EVAL_CASES) {
    const channel = c.scope === 'group' ? 'signal' : 'cli';
    const chatId = asChatId(c.scope === 'group' ? `signal:group:eval:${c.id}` : `cli:eval:${c.id}`);
    const mentioned =
      c.scope === 'group' ? (c.mentioned ?? c.userText.includes('@homie')) : undefined;
    const msg: IncomingMessage = {
      channel,
      chatId,
      messageId: asMessageId(`eval:${c.id}`),
      authorId: c.scope === 'group' ? '+10000000000' : 'user',
      text: c.userText,
      isGroup: c.scope === 'group',
      isOperator: false,
      ...(typeof mentioned === 'boolean' ? { mentioned } : {}),
      timestampMs: Date.now(),
    };

    const issues: EvalIssue[] = [];
    const warn = (message: string): void => {
      issues.push({ level: 'warn', message });
    };
    const fail = (message: string): void => {
      issues.push({ level: 'fail', message });
    };

    let out: OutgoingAction;
    try {
      out = await runTurnWithTimeout(engine, msg);
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      fail(`turn threw: ${msgText}`);
      results.push({
        id: c.id,
        title: c.title,
        scope: c.scope,
        input: c.userText,
        outputKind: 'error',
        status: 'fail',
        issues,
      });
      continue;
    }

    if (!c.allowedActions.includes(out.kind)) {
      fail(`unexpected action: got ${out.kind}, expected one of ${c.allowedActions.join(', ')}`);
    }

    let outputText: string | undefined;
    if (out.kind === 'send_text') {
      outputText = out.text;
      const maxChars = msg.isGroup ? cfg.behavior.groupMaxChars : cfg.behavior.dmMaxChars;
      if (out.text.length > maxChars) {
        fail(`too long: ${out.text.length} > ${maxChars}`);
      }
      if (msg.isGroup && out.text.includes('\n')) fail('group output contains newline');
      if (/\b(?:as an ai|as a language model)\b/iu.test(out.text)) {
        fail('mentions being an AI');
      }
      if (/^\s*(?:[-*]|\d+\.)\s+/u.test(out.text) && msg.isGroup) {
        warn('group output looks like a list');
      }

      const slop = checkSlop(out.text);
      if (slop.isSlop) {
        const reasons = slopReasons(slop).slice(0, 3).join('; ');
        fail(`slop: ${reasons || 'unknown'}`);
      }
    }

    const status: EvalStatus = issues.some((i) => i.level === 'fail')
      ? 'fail'
      : issues.some((i) => i.level === 'warn')
        ? 'warn'
        : 'pass';

    results.push({
      id: c.id,
      title: c.title,
      scope: c.scope,
      input: c.userText,
      outputKind: out.kind,
      ...(outputText ? { outputText } : {}),
      status,
      issues,
    });

    if (!opts.json) {
      const label = status.toUpperCase();
      const outSummary =
        out.kind === 'send_text'
          ? preview(out.text)
          : out.kind === 'react'
            ? out.emoji
            : '(silence)';
      process.stdout.write(`[${label}] ${c.id} — ${c.title}\n`);
      process.stdout.write(`in:  ${preview(c.userText, 180)}\n`);
      process.stdout.write(`out: ${out.kind} ${outSummary}\n`);
      if (issues.length) {
        for (const i of issues) process.stdout.write(`- ${i.level}: ${i.message}\n`);
      }
      if (c.notes) process.stdout.write(`note: ${c.notes}\n`);
      process.stdout.write('\n');
    }
  }

  const summary: { total: number; pass: number; warn: number; fail: number } = {
    total: 0,
    pass: 0,
    warn: 0,
    fail: 0,
  };
  for (const r of results) {
    summary.total += 1;
    summary[r.status] += 1;
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          configPath: loaded.configPath,
          provider: cfg.model.provider.kind,
          summary,
          results,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `eval summary: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail (total ${summary.total})\n`,
    );
  }

  if (summary.fail > 0) process.exit(2);
}
