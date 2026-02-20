import { createBackend } from '../../backend/factory.js';
import { shortAddress } from '../../util/format.js';
import {
  deriveMppWalletAddress,
  normalizeHttpUrl,
  normalizeMppPrivateKey,
} from '../../util/mpp.js';
import { makeTempConfig } from './initHelpers.js';

export type MppVerifyFailureCode =
  | 'missing_key'
  | 'invalid_key_format'
  | 'insufficient_funds'
  | 'wrong_network'
  | 'timeout'
  | 'endpoint_unreachable'
  | 'cancelled'
  | 'unknown';

export interface MppVerifyFailure {
  code: MppVerifyFailureCode;
  detail: string;
  nextStep: string;
}

export class MppVerifyError extends Error {
  public readonly failure: MppVerifyFailure;

  public constructor(failure: MppVerifyFailure) {
    super(`mpp_${failure.code}: ${failure.detail}`);
    this.name = 'MppVerifyError';
    this.failure = failure;
  }
}

interface VerifyMppAccessOptions {
  env: NodeJS.ProcessEnv & { MPP_PRIVATE_KEY?: string | undefined };
  model: string;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

const MPP_FUND_DOCS_URL = 'https://docs.tempo.xyz/guide/use-accounts/add-funds';

export const classifyMppVerifyFailure = (
  error: unknown,
  walletTarget: string,
): MppVerifyFailure => {
  const detail = error instanceof Error ? error.message : String(error);
  const low = detail.toLowerCase();
  if (low.includes('timeout') || low.includes('aborted')) {
    return {
      code: 'timeout',
      detail,
      nextStep: 'Retry in a few seconds. If persistent, check endpoint latency and network.',
    };
  }
  if (low.includes('cancelled') || low.includes('canceled') || low.includes('interrupted')) {
    return {
      code: 'cancelled',
      detail,
      nextStep: 'Request cancelled. Retry when you are ready.',
    };
  }
  if (low.includes('wrong network') || low.includes('switch network') || low.includes('chain')) {
    return {
      code: 'wrong_network',
      detail,
      nextStep: 'Switch to the expected network, then retry verification.',
    };
  }
  if (
    low.includes('insufficient') ||
    low.includes('payment required') ||
    low.includes('402') ||
    low.includes('balance')
  ) {
    return {
      code: 'insufficient_funds',
      detail,
      nextStep: `Fund ${walletTarget} on Base network and run verification again. Docs: ${MPP_FUND_DOCS_URL}`,
    };
  }
  if (
    low.includes('econnrefused') ||
    low.includes('enotfound') ||
    low.includes('fetch failed') ||
    low.includes('network')
  ) {
    return {
      code: 'endpoint_unreachable',
      detail,
      nextStep: 'Verify MPP endpoint URL and network access, then retry.',
    };
  }
  return {
    code: 'unknown',
    detail,
    nextStep: 'Retry verification; if it keeps failing, run homie doctor with --verify-mpp.',
  };
};

export const verifyMppModelAccess = async (options: VerifyMppAccessOptions): Promise<void> => {
  const rawKey = options.env.MPP_PRIVATE_KEY?.trim() ?? '';
  if (!rawKey) {
    throw new MppVerifyError({
      code: 'missing_key',
      detail: 'MPP_PRIVATE_KEY is missing',
      nextStep: 'Set MPP_PRIVATE_KEY in .env, then retry verification.',
    });
  }
  const key = normalizeMppPrivateKey(rawKey);
  if (!key) {
    throw new MppVerifyError({
      code: 'invalid_key_format',
      detail: 'MPP_PRIVATE_KEY must be a 0x-prefixed 64-byte hex key',
      nextStep: 'Replace MPP_PRIVATE_KEY with a valid private key and retry.',
    });
  }

  const timeoutMs = options.timeoutMs ?? 12_000;
  const normalizedBaseUrl = options.baseUrl ? normalizeHttpUrl(options.baseUrl) : undefined;
  const tempCfg = makeTempConfig('mpp', options.model, options.model, {
    baseUrl: normalizedBaseUrl,
  });
  const { backend } = await createBackend({ config: tempCfg, env: options.env });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const address = deriveMppWalletAddress(key);
  const walletTarget = address ? `wallet ${shortAddress(address)}` : 'wallet';
  try {
    await backend.complete({
      role: 'fast',
      messages: [
        { role: 'system', content: 'Return exactly: ok' },
        { role: 'user', content: 'healthcheck' },
      ],
      maxSteps: 1,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof MppVerifyError) throw err;
    throw new MppVerifyError(classifyMppVerifyFailure(err, walletTarget));
  } finally {
    clearTimeout(timer);
  }
};
