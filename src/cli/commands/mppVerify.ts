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
  | 'invalid_endpoint'
  | 'policy_denied'
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
  env: NodeJS.ProcessEnv & {
    MPP_PRIVATE_KEY?: string | undefined;
    MPP_RPC_URL?: string | undefined;
  };
  model: string;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

export const MPP_FUND_DOCS_URL = 'https://docs.tempo.xyz/guide/use-accounts/add-funds';

const isModeratoRpcUrl = (rpcUrl: string | undefined): boolean => {
  const raw = rpcUrl?.trim().toLowerCase();
  if (!raw) return false;
  return raw.includes('rpc.moderato.tempo.xyz');
};

const fundingNextStep = (params: {
  walletTarget: string;
  address?: string | undefined;
  rpcUrl?: string | undefined;
}): string => {
  if (params.address && isModeratoRpcUrl(params.rpcUrl)) {
    return [
      `Fund ${params.walletTarget} via the Tempo testnet faucet:`,
      `cast rpc tempo_fundAddress ${params.address} --rpc-url https://rpc.moderato.tempo.xyz`,
      `Docs: ${MPP_FUND_DOCS_URL}`,
    ].join(' ');
  }
  return `Fund ${params.walletTarget} on a Tempo-supported network and retry. Docs: ${MPP_FUND_DOCS_URL}`;
};

export const classifyMppVerifyFailure = (
  error: unknown,
  walletTarget: string,
): MppVerifyFailure => {
  const detail = error instanceof Error ? error.message : String(error);
  const low = detail.toLowerCase();
  if (low.includes('mpp_policy_denied') || low.includes('wallet_policy:')) {
    return {
      code: 'policy_denied',
      detail,
      nextStep:
        'Increase your MPP spend caps (OPENHOMIE_MPP_MAX_PER_REQUEST_USD / OPENHOMIE_MPP_MAX_PER_DAY_USD) or retry with a smaller request.',
    };
  }
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
    low.includes('no output generated') ||
    low.includes('empty response') ||
    low.includes('no content')
  ) {
    return {
      code: 'insufficient_funds',
      detail:
        'MPP endpoint returned an empty response (usually means the wallet is not funded or cannot pay for the request).',
      nextStep: `Fund ${walletTarget} on a Tempo-supported network and retry. Docs: ${MPP_FUND_DOCS_URL}`,
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
      nextStep: `Fund ${walletTarget} on a Tempo-supported network and run verification again. Docs: ${MPP_FUND_DOCS_URL}`,
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
  if (options.baseUrl !== undefined && !normalizedBaseUrl) {
    throw new MppVerifyError({
      code: 'invalid_endpoint',
      detail: `Invalid MPP endpoint URL: "${options.baseUrl}"`,
      nextStep: 'Provide a valid http(s) MPP endpoint and retry.',
    });
  }
  const rawRoot = (normalizedBaseUrl ?? 'https://mpp.tempo.xyz').replace(/\/+$/u, '');
  const rootBaseUrl = rawRoot.replace(/\/(openrouter|openai)\/v1$/u, '');
  const probeUrl = `${rootBaseUrl}/llms.txt`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const res = await fetch(probeUrl, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(
          `MPP proxy returned HTTP ${String(res.status)} on free probe (${probeUrl})`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MppVerifyError({
      code: 'endpoint_unreachable',
      detail: msg,
      nextStep: 'Verify MPP endpoint URL and network access, then retry.',
    });
  }
  const tempCfg = makeTempConfig('mpp', options.model, options.model, {
    baseUrl: rootBaseUrl,
  });
  const { backend } = await createBackend({ config: tempCfg, env: options.env });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const address = deriveMppWalletAddress(key);
  const walletTarget = address ? `wallet ${shortAddress(address)}` : 'wallet';
  try {
    const completion = backend.complete({
      role: 'fast',
      messages: [
        { role: 'system', content: 'Return exactly: ok' },
        { role: 'user', content: 'healthcheck' },
      ],
      maxSteps: 1,
      signal: controller.signal,
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('timeout'));
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    await Promise.race([completion, timeout]);
  } catch (err) {
    if (err instanceof MppVerifyError) throw err;
    const failure = classifyMppVerifyFailure(err, walletTarget);
    if (failure.code === 'insufficient_funds') {
      failure.nextStep = fundingNextStep({
        walletTarget,
        address,
        rpcUrl: options.env.MPP_RPC_URL,
      });
    }
    throw new MppVerifyError(failure);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
