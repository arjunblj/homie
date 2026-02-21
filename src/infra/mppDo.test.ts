import { describe, expect, test } from 'bun:test';
import { type FetchLike, MppDoClient, MppDoError } from './mppDo.js';

describe('MppDoClient', () => {
  test('lists regions', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ regions: [{ slug: 'nyc3', name: 'NYC 3', available: true }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    const client = new MppDoClient({ fetchImpl });
    const regions = await client.listRegions();
    expect(regions).toHaveLength(1);
    expect(regions[0]?.slug).toBe('nyc3');
  });

  test('creates droplet with expected payload shape', async () => {
    let bodyRaw = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      bodyRaw = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          droplet: { id: 1, name: 'homie-vps', status: 'new' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const client = new MppDoClient({ fetchImpl });
    const droplet = await client.createDroplet({
      name: 'homie-vps',
      region: 'nyc3',
      size: 's-1vcpu-1gb',
      image: 'ubuntu-24-04-x64',
      sshKeyIds: [123],
      userData: '#cloud-config',
    });

    expect(droplet.id).toBe(1);
    const parsed = JSON.parse(bodyRaw) as {
      name?: unknown;
      region?: unknown;
      user_data?: unknown;
      ssh_keys?: unknown;
    };
    expect(parsed.name).toBe('homie-vps');
    expect(parsed.region).toBe('nyc3');
    expect(parsed.user_data).toBe('#cloud-config');
    expect(parsed.ssh_keys).toEqual([123]);
  });

  test('maps HTTP 402 errors to insufficient_funds', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ message: 'payment required' }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });

    const client = new MppDoClient({ fetchImpl, retryCount: 0 });
    await expect(client.listDroplets()).rejects.toBeInstanceOf(MppDoError);
    await expect(client.listDroplets()).rejects.toMatchObject({
      kind: 'insufficient_funds',
      status: 402,
    });
  });

  test('maps transport 401-style errors to unauthorized', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error(
        'HTTP request failed. Status: 401 URL: https://rpc.tempo.xyz/ Details: {"message":"unauthorized"}',
      );
    };

    const client = new MppDoClient({ fetchImpl, retryCount: 0 });
    await expect(client.listRegions()).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  test('extracts public IPv4 helper', () => {
    const ip = MppDoClient.dropletPublicIpv4({
      id: 1,
      name: 'x',
      status: 'active',
      networks: {
        v4: [
          { type: 'private', ip_address: '10.0.0.2' },
          { type: 'public', ip_address: '143.198.1.10' },
        ],
      },
    });
    expect(ip).toBe('143.198.1.10');
  });

  test('does not retry non-idempotent createDroplet requests', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      throw new Error('fetch failed');
    };
    const client = new MppDoClient({ fetchImpl, retryCount: 3 });
    await expect(
      client.createDroplet({
        name: 'homie-vps',
        region: 'nyc3',
        size: 's-1vcpu-1gb',
        image: 'ubuntu-24-04-x64',
        sshKeyIds: [1],
      }),
    ).rejects.toBeInstanceOf(MppDoError);
    expect(calls).toBe(1);
  });
});
