import { describe, expect, it, vi } from 'vitest';
import { isRetryableProviderError, ProviderHttpError } from '../openai-provider.js';
import { RetryExhaustedError, retryProviderCall } from '../runtime-reliability.js';

describe('retryProviderCall', () => {
  it('Given terminal provider rejection, when it fails, then it does not retry', async () => {
    let attempts = 0;

    await expect(
      retryProviderCall({
        operation: async () => {
          attempts++;
          throw new ProviderHttpError(400);
        },
        retryable: (error) => error instanceof ProviderHttpError && error.status >= 500,
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ProviderHttpError);

    expect(attempts).toBe(1);
  });

  it('Given retryable failures, when attempts exhaust, then backoff is deterministic and bounded', async () => {
    const delays: number[] = [];
    let attempts = 0;

    await expect(
      retryProviderCall({
        operation: async () => {
          attempts++;
          throw new ProviderHttpError(503);
        },
        retryable: (error) => error instanceof ProviderHttpError && error.status >= 500,
        timeoutMs: 1_000,
        hooks: { sleep: async (delay) => void delays.push(delay) },
        policy: { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 8 },
      }),
    ).rejects.toThrow('retry budget exhausted');

    expect(attempts).toBe(3);
    expect(delays).toEqual([5, 8]);
  });

  it('Given a cancelled signal, when a provider call starts, then cancellation propagates without an attempt', async () => {
    const controller = new AbortController();
    const cancelled = new Error('caller cancelled');
    controller.abort(cancelled);
    let attempts = 0;

    await expect(
      retryProviderCall({
        operation: async () => {
          attempts++;
          return 'unexpected';
        },
        retryable: () => true,
        timeoutMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toBe(cancelled);

    expect(attempts).toBe(0);
  });

  it('Given hard timeouts, when attempts exhaust, then retries are bounded and lifecycle hooks are explicit', async () => {
    let attempts = 0;
    const retries: number[] = [];
    const timeouts: number[] = [];

    vi.useFakeTimers();
    try {
      const pending = retryProviderCall({
        operation: async (signal) => {
          attempts++;
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        retryable: isRetryableProviderError,
        timeoutMs: 1,
        hooks: {
          sleep: async () => undefined,
          onRetry: (attempt) => retries.push(attempt),
          onTimeout: (timeout) => timeouts.push(timeout),
        },
        policy: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(RetryExhaustedError);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expect(attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(timeouts).toEqual([1, 1, 1]);
  });
});
