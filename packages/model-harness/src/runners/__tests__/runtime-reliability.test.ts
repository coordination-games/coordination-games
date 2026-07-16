import { describe, expect, it } from 'vitest';
import { ProviderHttpError } from '../openai-provider.js';
import { retryProviderCall } from '../runtime-reliability.js';

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
});
