import { setTimeout as sleep } from 'node:timers/promises';

export type MppDoErrorKind =
  | 'insufficient_funds'
  | 'endpoint_unreachable'
  | 'timeout'
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'unknown';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class MppDoError extends Error {
  public readonly kind: MppDoErrorKind;
  public readonly status: number | undefined;
  public readonly detail: string;

  public constructor(
    kind: MppDoErrorKind,
    detail: string,
    options?: { status?: number | undefined },
  ) {
    super(`mpp_do_${kind}: ${detail}`);
    this.name = 'MppDoError';
    this.kind = kind;
    this.status = options?.status;
    this.detail = detail;
  }
}

export interface MppDoClientOptions {
  readonly rootBaseUrl?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly retryCount?: number | undefined;
  readonly retryDelayMs?: number | undefined;
}

export interface MppDoRegion {
  readonly slug: string;
  readonly name: string;
  readonly available: boolean;
}

export interface MppDoSize {
  readonly slug: string;
  readonly memory: number;
  readonly vcpus: number;
  readonly disk: number;
  readonly available: boolean;
}

export interface MppDoImage {
  readonly id: number;
  readonly slug?: string | undefined;
  readonly name?: string | undefined;
  readonly distribution?: string | undefined;
}

export interface MppDoSshKey {
  readonly id: number;
  readonly name: string;
  readonly fingerprint: string;
  readonly public_key?: string | undefined;
}

export interface MppDoDropletNetworkV4 {
  readonly ip_address: string;
  readonly type: string;
}

export interface MppDoDropletNetworks {
  readonly v4?: readonly MppDoDropletNetworkV4[] | undefined;
}

export interface MppDoDroplet {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly size_slug?: string | undefined;
  readonly region?: { slug?: string | undefined } | undefined;
  readonly image?: { slug?: string | undefined; id?: number | undefined } | undefined;
  readonly networks?: MppDoDropletNetworks | undefined;
}

export interface CreateDropletInput {
  readonly name: string;
  readonly region: string;
  readonly size: string;
  readonly image: string;
  readonly sshKeyIds: readonly number[];
  readonly userData?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly enableBackups?: boolean | undefined;
  readonly enableMonitoring?: boolean | undefined;
}

const normalizeRootBaseUrl = (value: string | undefined): string => {
  const root = (value ?? 'https://mpp.tempo.xyz').trim().replace(/\/+$/u, '');
  return root || 'https://mpp.tempo.xyz';
};

const tryParseJson = async (res: Response): Promise<unknown> => {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined;
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
};

const extractErrorMessage = (body: unknown): string => {
  if (!body || typeof body !== 'object') return '';
  const rec = body as Record<string, unknown>;
  const message = rec['message'];
  if (typeof message === 'string' && message.trim()) return message.trim();
  const error = rec['error'];
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const nested = (error as Record<string, unknown>)['message'];
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return '';
};

const classifyError = (status: number | undefined, detail: string): MppDoErrorKind => {
  const low = detail.toLowerCase();
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 401 || status === 403) return 'unauthorized';
  if (
    low.includes('unauthorized') ||
    low.includes('authentication required') ||
    low.includes('status: 401') ||
    low.includes('status: 403')
  ) {
    return 'unauthorized';
  }
  if (status === 402 || low.includes('insufficient') || low.includes('payment required')) {
    return 'insufficient_funds';
  }
  if (low.includes('timed out') || low.includes('timeout') || low.includes('aborted')) {
    return 'timeout';
  }
  if (
    low.includes('fetch failed') ||
    low.includes('econnrefused') ||
    low.includes('enotfound') ||
    low.includes('network')
  ) {
    return 'endpoint_unreachable';
  }
  return 'unknown';
};

interface DigitalOceanActionResponse {
  readonly action?: {
    readonly id?: number | undefined;
    readonly status?: string | undefined;
    readonly type?: string | undefined;
  };
}

export class MppDoClient {
  private readonly rootBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly retryCount: number;
  private readonly retryDelayMs: number;

  public constructor(options: MppDoClientOptions = {}) {
    this.rootBaseUrl = normalizeRootBaseUrl(options.rootBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryCount = options.retryCount ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 350;
  }

  public async listRegions(): Promise<readonly MppDoRegion[]> {
    const body = await this.requestJson<{ regions?: readonly MppDoRegion[] }>(
      'GET',
      '/digitalocean/v2/regions',
    );
    return body.regions ?? [];
  }

  public async listSizes(): Promise<readonly MppDoSize[]> {
    const body = await this.requestJson<{ sizes?: readonly MppDoSize[] }>(
      'GET',
      '/digitalocean/v2/sizes',
    );
    return body.sizes ?? [];
  }

  public async listImages(parameters?: { perPage?: number | undefined }): Promise<readonly MppDoImage[]> {
    const query = parameters?.perPage ? `?per_page=${String(parameters.perPage)}` : '';
    const body = await this.requestJson<{ images?: readonly MppDoImage[] }>(
      'GET',
      `/digitalocean/v2/images${query}`,
    );
    return body.images ?? [];
  }

  public async createSshKey(name: string, publicKey: string): Promise<MppDoSshKey> {
    const body = await this.requestJson<{ ssh_key?: MppDoSshKey }>('POST', '/digitalocean/v2/account/keys', {
      name,
      public_key: publicKey,
    });
    if (!body.ssh_key) throw new MppDoError('unknown', 'DigitalOcean key create response missing ssh_key');
    return body.ssh_key;
  }

  public async listSshKeys(): Promise<readonly MppDoSshKey[]> {
    const body = await this.requestJson<{ ssh_keys?: readonly MppDoSshKey[] }>(
      'GET',
      '/digitalocean/v2/account/keys',
    );
    return body.ssh_keys ?? [];
  }

  public async deleteSshKey(id: number): Promise<void> {
    await this.requestJson('DELETE', `/digitalocean/v2/account/keys/${String(id)}`);
  }

  public async createDroplet(input: CreateDropletInput): Promise<MppDoDroplet> {
    const body = await this.requestJson<{ droplet?: MppDoDroplet }>('POST', '/digitalocean/v2/droplets', {
      name: input.name,
      region: input.region,
      size: input.size,
      image: input.image,
      ssh_keys: input.sshKeyIds,
      ...(input.userData ? { user_data: input.userData } : {}),
      ...(input.tags && input.tags.length ? { tags: input.tags } : {}),
      ...(input.enableBackups !== undefined ? { backups: input.enableBackups } : {}),
      ...(input.enableMonitoring !== undefined ? { monitoring: input.enableMonitoring } : {}),
    });
    if (!body.droplet) throw new MppDoError('unknown', 'DigitalOcean create response missing droplet');
    return body.droplet;
  }

  public async listDroplets(): Promise<readonly MppDoDroplet[]> {
    const body = await this.requestJson<{ droplets?: readonly MppDoDroplet[] }>(
      'GET',
      '/digitalocean/v2/droplets',
    );
    return body.droplets ?? [];
  }

  public async getDroplet(id: number): Promise<MppDoDroplet> {
    const body = await this.requestJson<{ droplet?: MppDoDroplet }>(
      'GET',
      `/digitalocean/v2/droplets/${String(id)}`,
    );
    if (!body.droplet) throw new MppDoError('unknown', 'DigitalOcean get response missing droplet');
    return body.droplet;
  }

  public async deleteDroplet(id: number): Promise<void> {
    await this.requestJson('DELETE', `/digitalocean/v2/droplets/${String(id)}`);
  }

  public async dropletAction(
    id: number,
    actionType: 'power_on' | 'power_off' | 'reboot' | 'shutdown' | 'power_cycle',
  ): Promise<DigitalOceanActionResponse['action']> {
    const body = await this.requestJson<DigitalOceanActionResponse>(
      'POST',
      `/digitalocean/v2/droplets/${String(id)}/actions`,
      { type: actionType },
    );
    return body.action;
  }

  public static dropletPublicIpv4(droplet: MppDoDroplet): string | undefined {
    const networks = droplet.networks?.v4;
    if (!networks || networks.length === 0) return undefined;
    const publicNetwork = networks.find((network) => network.type === 'public');
    return publicNetwork?.ip_address;
  }

  private async requestJson<T extends unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.rootBaseUrl}${path}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            Accept: 'application/json',
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const jsonBody = await tryParseJson(res);
        if (!res.ok) {
          const detail = extractErrorMessage(jsonBody) || `HTTP ${String(res.status)} on ${path}`;
          throw new MppDoError(classifyError(res.status, detail), detail, { status: res.status });
        }
        return (jsonBody as T | undefined) ?? ({} as T);
      } catch (err) {
        lastErr = err;
        const detail = err instanceof Error ? err.message : String(err);
        const kind = err instanceof MppDoError ? err.kind : classifyError(undefined, detail);
        const canRetry =
          attempt < this.retryCount &&
          (kind === 'endpoint_unreachable' || kind === 'timeout' || kind === 'unknown');
        if (!canRetry) {
          if (err instanceof MppDoError) throw err;
          throw new MppDoError(kind, detail);
        }
        await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
    const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new MppDoError('unknown', detail);
  }
}
