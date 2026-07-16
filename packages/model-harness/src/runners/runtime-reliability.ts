export type RetryPolicy = {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 1_000,
};

export class RetryExhaustedError extends Error {
  readonly name = 'RetryExhaustedError';
  constructor(
    readonly attempts: number,
    readonly cause: unknown,
  ) {
    super(`Provider retry budget exhausted after ${attempts} attempts`, { cause });
  }
}

export class RuntimeTimeoutError extends Error {
  readonly name = 'RuntimeTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`Provider call exceeded ${timeoutMs}ms without a heartbeat`);
  }
}

export class ToolCorrectionExhaustedError extends Error {
  readonly name = 'ToolCorrectionExhaustedError';
  constructor(
    readonly corrections: number,
    readonly reason: string,
  ) {
    super(`Tool-call correction budget exhausted after ${corrections} correction(s): ${reason}`);
  }
}

export type RuntimeHooks = {
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly onRetry?: (attempt: number, delayMs: number) => void;
  readonly onTimeout?: (timeoutMs: number) => void;
};

export async function retryProviderCall<T>(input: {
  readonly operation: (signal: AbortSignal) => Promise<T>;
  readonly retryable: (error: unknown) => boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly policy?: RetryPolicy;
  readonly hooks?: RuntimeHooks;
}): Promise<T> {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const controller = new AbortController();
    const abortParent = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abortParent, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new RuntimeTimeoutError(input.timeoutMs)),
      input.timeoutMs,
    );
    try {
      if (input.signal?.aborted) throw input.signal.reason;
      return await input.operation(controller.signal);
    } catch (error) {
      lastError =
        controller.signal.reason instanceof RuntimeTimeoutError ? controller.signal.reason : error;
      const onTimeout = input.hooks?.onTimeout;
      if (lastError instanceof RuntimeTimeoutError && onTimeout) onTimeout(input.timeoutMs);
      if (!input.retryable(lastError) || attempt === policy.maxAttempts || input.signal?.aborted) {
        throw attempt === policy.maxAttempts && input.retryable(lastError)
          ? new RetryExhaustedError(attempt, lastError)
          : lastError;
      }
      const delayMs = Math.min(policy.initialDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      const onRetry = input.hooks?.onRetry;
      if (onRetry) onRetry(attempt, delayMs);
      await (input.hooks?.sleep ?? sleep)(delayMs, input.signal ?? controller.signal);
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abortParent);
    }
  }
  throw new RetryExhaustedError(policy.maxAttempts, lastError);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
