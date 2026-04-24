/**
 * RPC fallback transport.
 *
 * Wraps viem's `http()` transport with a list of URLs. On transport errors
 * (network failure, 5xx, timeout), advances to the next URL with exponential
 * backoff. The successful URL is cached for the lifetime of the wrapper, so
 * subsequent viem calls (e.g. multiple `readContract` invocations in the same
 * auth handler) reuse the known-good endpoint without re-probing dead ones.
 *
 * Why hand-rolled instead of viem's `fallback([http(a), http(b)])`?
 *  - viem's fallback retries from index 0 on every request — a dead first URL
 *    burns time on every call. We want per-request URL caching.
 *  - viem's fallback has no inter-fallback backoff.
 *  - We want structured per-RPC failure observability.
 *
 * Contract-revert errors (ContractFunctionRevertedError, etc.) bubble up
 * unchanged — they are NOT transport failures and should not trigger failover.
 */

import { createPublicClient, http, type PublicClient, type Transport } from 'viem';
import { optimismSepolia } from 'viem/chains';
import type { Env } from './env.js';

const BACKOFF_BASE_MS = 100;
const BACKOFF_CEILING_MS = 2_000;

export interface RpcStats {
  /** Per-URL counters for the lifetime of this client. */
  perUrl: Record<string, { successes: number; failures: number }>;
  /** Currently cached URL (the one most recently used successfully). */
  currentUrl: string | null;
}

export interface FallbackClient {
  /** A viem PublicClient that transparently fails over across RPC URLs. */
  client: PublicClient;
  /** Snapshot of per-URL success/failure counters. */
  getStats(): RpcStats;
}

/**
 * Read RPC URLs from env. `RPC_URLS` (comma-separated) takes precedence over
 * legacy `RPC_URL`. Returns an empty array when neither is set.
 */
export function parseRpcUrls(env: Env): string[] {
  const raw = env.RPC_URLS ?? env.RPC_URL;
  if (!raw) return [];
  return raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/**
 * Classify an error thrown by an inner viem transport request.
 *
 * Returns true for errors we should retry on the next URL: network failures,
 * 5xx responses, timeouts. Returns false for errors that indicate the request
 * was understood and should not be retried elsewhere — contract reverts,
 * malformed responses, JSON-RPC application errors with a code.
 */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return true; // unknown shape — assume transport
  const name = err.name ?? '';
  const msg = err.message ?? '';

  // viem-specific: contract reverts are NOT transport errors.
  if (name === 'ContractFunctionRevertedError') return false;
  if (name === 'ContractFunctionExecutionError') return false;
  if (name === 'ContractFunctionZeroDataError') return false;
  if (name === 'AbiDecodingZeroDataError') return false;

  // RPC application-level errors that came back as a valid JSON-RPC response.
  // These have a numeric `code` field per JSON-RPC 2.0.
  const maybeCode = (err as { code?: unknown }).code;
  if (typeof maybeCode === 'number') {
    // Application-coded responses mean the RPC was reachable enough to return
    // a coded JSON-RPC response. Those are not transport failures.
    return false;
  }

  // viem HTTP/timeout/network errors.
  if (name === 'HttpRequestError') return true;
  if (name === 'TimeoutError') return true;
  if (name === 'AbortError') return true;
  if (name === 'TypeError' && /fetch|network/i.test(msg)) return true;

  // 5xx surfaced in message string (viem includes status in message).
  if (/\b5\d\d\b/.test(msg)) return true;
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(msg)) return true;

  // Default: assume transport error so that genuinely unknown failures still
  // failover. Worst case we waste one attempt on the next URL.
  return true;
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CEILING_MS);
}

/**
 * Override hooks (used by tests). In production, these go through real viem
 * transports.
 */
export interface FallbackOptions {
  /** Override the inner transport factory. Default: viem's `http()`. */
  transportFactory?: (url: string) => Transport;
  /** Override sleep — tests can stub this to skip backoff delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Logger sink — defaults to console. */
  logger?: Pick<Console, 'warn' | 'error' | 'info'>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Build a PublicClient backed by a fallback list of RPC URLs.
 *
 * Throws synchronously when `urls` is empty — callers should check first.
 */
export function createFallbackPublicClient(
  urls: string[],
  opts: FallbackOptions = {},
): FallbackClient {
  if (urls.length === 0) {
    throw new Error('createFallbackPublicClient: at least one RPC URL is required');
  }

  const transportFactory = opts.transportFactory ?? ((url: string) => http(url));
  const sleep = opts.sleep ?? defaultSleep;
  const logger = opts.logger ?? console;

  // Per-URL counters and rolling failure rate (last 20 attempts per URL).
  const stats: Record<string, { successes: number; failures: number; recent: boolean[] }> = {};
  for (const url of urls) stats[url] = { successes: 0, failures: 0, recent: [] };
  const RECENT_WINDOW = 20;
  const ALERT_RATE = 0.5;
  const ALERT_MIN_SAMPLES = 10;

  // Cached index of the URL most recently known to be working.
  let currentIndex = 0;

  const recordResult = (url: string, ok: boolean, errorClass?: string) => {
    const s = stats[url];
    if (!s) return;
    if (ok) s.successes++;
    else s.failures++;
    s.recent.push(ok);
    if (s.recent.length > RECENT_WINDOW) s.recent.shift();

    if (!ok) {
      logger.warn(
        `[rpc-fallback] failure rpc=${url} errorClass=${errorClass ?? 'unknown'} ` +
          `successes=${s.successes} failures=${s.failures}`,
      );

      const failed = s.recent.filter((r) => !r).length;
      if (s.recent.length >= ALERT_MIN_SAMPLES && failed / s.recent.length >= ALERT_RATE) {
        logger.error(
          `[rpc-fallback] ALERT: rpc=${url} failure rate ${failed}/${s.recent.length} ` +
            `(>=${ALERT_RATE * 100}%) over last ${s.recent.length} attempts`,
        );
      }
    }
  };

  // Custom transport: builds one inner viem http() transport per URL up front
  // and reuses them. The `request` function tries cached URL first, then the
  // remaining URLs in original order with exponential backoff between attempts.
  const fallbackTransport: Transport = (params) => {
    const innerTransports = urls.map((url) => transportFactory(url)(params));

    // biome-ignore lint/suspicious/noExplicitAny: EIP-1193 request signature
    const request = async (req: any): Promise<any> => {
      // Try cached current URL first, then the rest in original order.
      const order: number[] = [currentIndex];
      for (let i = 0; i < urls.length; i++) if (i !== currentIndex) order.push(i);

      let lastErr: unknown;
      for (let attempt = 0; attempt < order.length; attempt++) {
        const idx = order[attempt] as number;
        const url = urls[idx] as string;
        const inner = innerTransports[idx];
        if (!inner) {
          // Defensive: should never happen given how `order` is built.
          throw new Error(`rpc-fallback: missing inner transport at index ${idx}`);
        }
        try {
          const response = await inner.request(req);
          recordResult(url, true);
          currentIndex = idx;
          return response;
        } catch (err) {
          const errClass = err instanceof Error ? err.name || 'Error' : typeof err;
          recordResult(url, false, errClass);
          lastErr = err;

          if (!isTransportError(err)) {
            // Non-transport (e.g. contract revert) — bubble immediately.
            throw err;
          }

          // Last URL exhausted — give up.
          if (attempt === order.length - 1) break;

          // Exponential backoff, then try next URL.
          await sleep(backoffMs(attempt));
        }
      }

      const lastErrMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(
        `All ${urls.length} RPC URL(s) failed for ${req.method}. Last error: ${lastErrMsg}`,
        { cause: lastErr instanceof Error ? lastErr : undefined },
      );
    };

    return {
      config: {
        key: 'rpc-fallback',
        name: 'RPC Fallback',
        // biome-ignore lint/suspicious/noExplicitAny: viem TransportConfig.request typing
        request: request as any,
        type: 'rpc-fallback',
      },
      // biome-ignore lint/suspicious/noExplicitAny: viem Transport request typing
      request: request as any,
    } as ReturnType<Transport>;
  };

  const client = createPublicClient({
    chain: optimismSepolia,
    transport: fallbackTransport,
  }) as PublicClient;

  return {
    client,
    getStats(): RpcStats {
      const perUrl: RpcStats['perUrl'] = {};
      for (const [url, s] of Object.entries(stats)) {
        perUrl[url] = { successes: s.successes, failures: s.failures };
      }
      return {
        perUrl,
        currentUrl: urls[currentIndex] ?? null,
      };
    },
  };
}
