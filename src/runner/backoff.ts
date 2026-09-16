/**
 * ddlforge - Exponential backoff with full jitter for lock-timeout retry loops.
 *
 * Algorithm: sleep = Math.random() * Math.min(maxDelay, baseDelay * 2 ** attempt)
 * This prevents lock-convoy / stampede effects by randomising each retry interval.
 */

export interface BackoffOptions {
  /** Base delay in milliseconds (default: 250 ms) */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 10_000 ms = 10 s) */
  maxDelayMs?: number;
  /** Maximum number of retry attempts (default: 5) */
  maxRetries?: number;
}

export interface BackoffResult {
  /** How long to sleep in milliseconds */
  sleepMs: number;
  /** Current attempt index (0-based) */
  attempt: number;
  /** Whether the maximum retry count has been exceeded */
  exceeded: boolean;
}

/**
 * Computes a full-jitter exponential backoff interval for the given attempt index.
 *
 * @param attempt   0-based attempt index (first retry = 0)
 * @param options   Backoff configuration
 * @returns         Randomised sleep duration in milliseconds
 */
export function computeBackoff(attempt: number, options: BackoffOptions = {}): BackoffResult {
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs  = options.maxDelayMs  ?? 10_000;
  const maxRetries  = options.maxRetries  ?? 5;

  const ceiling  = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const sleepMs  = Math.random() * ceiling;
  const exceeded = attempt >= maxRetries;

  return { sleepMs, attempt, exceeded };
}

/**
 * Returns a promise that resolves after `ms` milliseconds.
 * Optionally accepts an AbortSignal: if the signal is aborted before the
 * timer fires, the promise rejects with the signal's reason.
 *
 * @param ms      Sleep duration in milliseconds
 * @param signal  Optional AbortSignal for cancellation
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(this: AbortSignal): void {
      clearTimeout(timer);
      reject((this as AbortSignal).reason ?? new Error('AbortError'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Iterates over retry attempts, yielding the computed backoff for each attempt.
 * Callers should `sleep(backoff.sleepMs)` after receiving each non-first result.
 *
 * Example:
 * ```ts
 * for (const backoff of retryIterator(3, opts)) {
 *   if (backoff.attempt > 0) await sleep(backoff.sleepMs, signal);
 *   // ... attempt work ...
 * }
 * ```
 */
export function* retryIterator(
  maxRetries: number,
  options: Omit<BackoffOptions, 'maxRetries'> = {},
): Generator<BackoffResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    yield computeBackoff(attempt, { ...options, maxRetries });
  }
}
