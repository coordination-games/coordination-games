/**
 * Unit tests for the RPC fallback transport (Phase 3.7).
 *
 * These tests verify the failover behaviour by stubbing viem's inner transport
 * factory. We don't make real HTTP calls.
 */

import { encodeAbiParameters } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFallbackPublicClient, isTransportError, parseRpcUrls } from '../rpc-fallback.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeTransportSpec {
  url: string;
  /**
   * Behaviour on each call — pull from queue. If queue empty, fall back to
   * `default`. Each entry is either:
   *  - a thrown Error (typeof Error or {throw: Error})
   *  - a returned value
   */
  responses: Array<{ throw?: unknown; return?: unknown }>;
  defaultResponse?: { throw?: unknown; return?: unknown };
}

interface CallLog {
  url: string;
  method: string;
  params: unknown[];
}

function buildFakeTransports(specs: FakeTransportSpec[]) {
  const calls: CallLog[] = [];
  // Maps url -> a viem-compatible transport factory (called once per
  // createPublicClient invocation).
  const factory = (url: string) => {
    const spec = specs.find((s) => s.url === url);
    if (!spec) throw new Error(`No fake spec for url=${url}`);

    // Return something shaped like a viem Transport: a function that returns
    // {config, request}.
    return (() => {
      const request = async (req: { method: string; params?: unknown[] }) => {
        calls.push({ url, method: req.method, params: req.params ?? [] });
        const next = spec.responses.shift() ?? spec.defaultResponse;
        if (!next) throw new Error(`No response queued for url=${url}`);
        if (next.throw) throw next.throw;
        return next.return;
      };
      return {
        config: { key: 'fake', name: 'Fake', request, type: 'fake' },
        request,
      };
      // biome-ignore lint/suspicious/noExplicitAny: viem Transport return type
    }) as any;
  };

  return { factory, calls };
}

// ---------------------------------------------------------------------------
// parseRpcUrls
// ---------------------------------------------------------------------------

describe('parseRpcUrls', () => {
  it('returns [] when neither RPC_URLS nor RPC_URL is set', () => {
    expect(parseRpcUrls({} as never)).toEqual([]);
  });

  it('falls back to RPC_URL when RPC_URLS is unset', () => {
    expect(parseRpcUrls({ RPC_URL: 'https://a' } as never)).toEqual(['https://a']);
  });

  it('prefers RPC_URLS over RPC_URL', () => {
    expect(
      parseRpcUrls({ RPC_URLS: 'https://a,https://b', RPC_URL: 'https://c' } as never),
    ).toEqual(['https://a', 'https://b']);
  });

  it('trims whitespace and drops empty entries', () => {
    expect(parseRpcUrls({ RPC_URLS: ' https://a , , https://b ' } as never)).toEqual([
      'https://a',
      'https://b',
    ]);
  });
});

// ---------------------------------------------------------------------------
// isTransportError
// ---------------------------------------------------------------------------

describe('isTransportError', () => {
  it('treats HttpRequestError as transport error', () => {
    const err = new Error('boom');
    err.name = 'HttpRequestError';
    expect(isTransportError(err)).toBe(true);
  });

  it('treats ContractFunctionRevertedError as non-transport', () => {
    const err = new Error('reverted');
    err.name = 'ContractFunctionRevertedError';
    expect(isTransportError(err)).toBe(false);
  });

  it('treats ContractFunctionExecutionError as non-transport', () => {
    const err = new Error('exec failed');
    err.name = 'ContractFunctionExecutionError';
    expect(isTransportError(err)).toBe(false);
  });

  it('treats JSON-RPC coded errors as non-transport', () => {
    const err = Object.assign(new Error('rpc err'), { code: -32000 });
    expect(isTransportError(err)).toBe(false);
  });

  it('treats 5xx-in-message as transport error', () => {
    expect(isTransportError(new Error('Request failed with status 503'))).toBe(true);
  });

  it('treats fetch failed as transport error', () => {
    expect(isTransportError(new Error('fetch failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failover behaviour
// ---------------------------------------------------------------------------

describe('createFallbackPublicClient — failover', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('throws when constructed with no URLs', () => {
    expect(() => createFallbackPublicClient([])).toThrow(/at least one RPC URL/);
  });

  // The encoded value 0x00...01 — a valid ABI-encoded uint256(1).
  const encodedOne = encodeAbiParameters([{ type: 'uint256' }], [1n]);
  const encodedAddr = encodeAbiParameters(
    [{ type: 'address' }],
    ['0x0000000000000000000000000000000000000001'],
  );

  it('first RPC returns 500 → request succeeds via second RPC', async () => {
    const httpErr = Object.assign(new Error('Request failed with status 503'), {
      name: 'HttpRequestError',
    });
    const { factory, calls } = buildFakeTransports([
      {
        url: 'https://dead',
        responses: [{ throw: httpErr }],
      },
      {
        url: 'https://alive',
        responses: [],
        defaultResponse: { return: encodedOne },
      },
    ]);

    const { client, getStats } = createFallbackPublicClient(['https://dead', 'https://alive'], {
      transportFactory: factory,
      sleep: async () => {},
    });

    const result = await client.readContract({
      address: '0x0000000000000000000000000000000000000001',
      abi: [
        {
          name: 'nameToAgent',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'k', type: 'bytes32' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'nameToAgent',
      args: ['0x0000000000000000000000000000000000000000000000000000000000000001'],
    });

    expect(result).toBe(1n);
    // First attempt hit dead, then alive.
    expect(calls.map((c) => c.url)).toEqual(['https://dead', 'https://alive']);

    const stats = getStats();
    expect(stats.currentUrl).toBe('https://alive');
    expect(stats.perUrl['https://dead']).toEqual({ successes: 0, failures: 1 });
    expect(stats.perUrl['https://alive']).toEqual({ successes: 1, failures: 0 });
  });

  it('all RPCs fail → throws explicit aggregate error (not a timeout)', async () => {
    const httpErr = Object.assign(new Error('Request failed with status 503'), {
      name: 'HttpRequestError',
    });
    const { factory, calls } = buildFakeTransports([
      { url: 'https://a', responses: [{ throw: httpErr }] },
      { url: 'https://b', responses: [{ throw: httpErr }] },
    ]);

    const { client, getStats } = createFallbackPublicClient(['https://a', 'https://b'], {
      transportFactory: factory,
      sleep: async () => {},
    });

    await expect(
      client.readContract({
        address: '0x0000000000000000000000000000000000000001',
        abi: [
          {
            name: 'nameToAgent',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'k', type: 'bytes32' }],
            outputs: [{ name: '', type: 'uint256' }],
          },
        ] as const,
        functionName: 'nameToAgent',
        args: ['0x0000000000000000000000000000000000000000000000000000000000000001'],
      }),
    ).rejects.toThrow(/All 2 RPC URL\(s\) failed/);

    expect(calls.map((c) => c.url)).toEqual(['https://a', 'https://b']);

    const stats = getStats();
    expect(stats.perUrl['https://a']).toEqual({ successes: 0, failures: 1 });
    expect(stats.perUrl['https://b']).toEqual({ successes: 0, failures: 1 });
  });

  it('successful URL is cached across subsequent calls in the same client', async () => {
    const httpErr = Object.assign(new Error('Request failed with status 503'), {
      name: 'HttpRequestError',
    });
    const { factory, calls } = buildFakeTransports([
      {
        url: 'https://dead',
        // Always fail every call. If caching works, this should be hit
        // exactly ONCE (on the first request); subsequent requests skip it.
        responses: [],
        defaultResponse: { throw: httpErr },
      },
      {
        url: 'https://alive',
        responses: [{ return: encodedOne }, { return: encodedAddr }],
      },
    ]);

    const { client, getStats } = createFallbackPublicClient(['https://dead', 'https://alive'], {
      transportFactory: factory,
      sleep: async () => {},
    });

    const erc8004Abi = [
      {
        name: 'nameToAgent',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'k', type: 'bytes32' }],
        outputs: [{ name: '', type: 'uint256' }],
      },
      {
        name: 'ownerOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        outputs: [{ name: '', type: 'address' }],
      },
    ] as const;

    // First call: probes dead, then alive.
    const agentId = await client.readContract({
      address: '0x0000000000000000000000000000000000000001',
      abi: erc8004Abi,
      functionName: 'nameToAgent',
      args: ['0x0000000000000000000000000000000000000000000000000000000000000001'],
    });
    expect(agentId).toBe(1n);

    // Second call: should go directly to alive (cached). No new dead hit.
    const owner = await client.readContract({
      address: '0x0000000000000000000000000000000000000001',
      abi: erc8004Abi,
      functionName: 'ownerOf',
      args: [1n],
    });
    expect((owner as string).toLowerCase()).toBe('0x0000000000000000000000000000000000000001');

    // dead should appear exactly once in the call log; alive twice.
    const deadHits = calls.filter((c) => c.url === 'https://dead').length;
    const aliveHits = calls.filter((c) => c.url === 'https://alive').length;
    expect(deadHits).toBe(1);
    expect(aliveHits).toBe(2);

    const stats = getStats();
    expect(stats.currentUrl).toBe('https://alive');
    expect(stats.perUrl['https://dead']).toEqual({ successes: 0, failures: 1 });
    expect(stats.perUrl['https://alive']).toEqual({ successes: 2, failures: 0 });
  });

  it('does not failover on contract reverts (non-transport errors)', async () => {
    const revertErr = Object.assign(new Error('reverted'), {
      name: 'ContractFunctionRevertedError',
    });
    const { factory, calls } = buildFakeTransports([
      { url: 'https://a', responses: [{ throw: revertErr }] },
      { url: 'https://b', responses: [], defaultResponse: { return: encodedOne } },
    ]);

    const { client } = createFallbackPublicClient(['https://a', 'https://b'], {
      transportFactory: factory,
      sleep: async () => {},
    });

    await expect(
      client.readContract({
        address: '0x0000000000000000000000000000000000000001',
        abi: [
          {
            name: 'nameToAgent',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'k', type: 'bytes32' }],
            outputs: [{ name: '', type: 'uint256' }],
          },
        ] as const,
        functionName: 'nameToAgent',
        args: ['0x0000000000000000000000000000000000000000000000000000000000000001'],
      }),
    ).rejects.toThrow();

    // Only the first RPC was contacted — no failover on a revert.
    expect(calls.map((c) => c.url)).toEqual(['https://a']);
  });

  it('logs a structured warning per RPC failure', async () => {
    const httpErr = Object.assign(new Error('Request failed with status 503'), {
      name: 'HttpRequestError',
    });
    const warn = vi.fn();
    const { factory } = buildFakeTransports([
      { url: 'https://a', responses: [{ throw: httpErr }] },
      { url: 'https://b', responses: [], defaultResponse: { return: encodedOne } },
    ]);

    const { client } = createFallbackPublicClient(['https://a', 'https://b'], {
      transportFactory: factory,
      sleep: async () => {},
      logger: { warn, error: vi.fn(), info: vi.fn() },
    });

    await client.readContract({
      address: '0x0000000000000000000000000000000000000001',
      abi: [
        {
          name: 'nameToAgent',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'k', type: 'bytes32' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'nameToAgent',
      args: ['0x0000000000000000000000000000000000000000000000000000000000000001'],
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const firstCall = warn.mock.calls[0];
    if (!firstCall) throw new Error('expected warn call');
    const msg = firstCall[0] as string;
    expect(msg).toMatch(/\[rpc-fallback\] failure rpc=https:\/\/a/);
    expect(msg).toMatch(/errorClass=HttpRequestError/);
  });
});
