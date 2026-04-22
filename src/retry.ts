import type { RetryPolicy } from './types.js';
import { isPermanent } from './errors.js';

const DEFAULTS = {
  maxAttempts: 1,
  backoff: 'exponential' as const,
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: true as boolean | number,
};

/**
 * Compute the delay (ms) before the next attempt. Attempt numbers are 1-based;
 * `attempt` here is the attempt that just failed, so the next attempt is
 * `attempt + 1` and waits for the delay returned here.
 */
export function computeDelay(policy: RetryPolicy | undefined, attempt: number): number {
  const p = { ...DEFAULTS, ...(policy ?? {}) };
  const n = Math.max(1, attempt);

  let base: number;
  switch (p.backoff) {
    case 'fixed':
      base = p.initialDelayMs;
      break;
    case 'linear':
      base = p.initialDelayMs * n;
      break;
    case 'exponential':
    default:
      base = p.initialDelayMs * Math.pow(p.multiplier, n - 1);
      break;
  }

  base = Math.min(base, p.maxDelayMs);

  if (p.jitter === false) return base;
  const factor = typeof p.jitter === 'number' ? Math.max(0, Math.min(1, p.jitter)) : 1;
  // full jitter: random in [base*(1-factor), base]
  const min = base * (1 - factor);
  return min + Math.random() * (base - min);
}

/**
 * Decide whether `error` should trigger another attempt given the current
 * policy and attempt count. Callers still need to enforce maxAttempts.
 */
export function shouldRetryError(
  policy: RetryPolicy | undefined,
  error: unknown,
  attempt: number,
): boolean {
  if (policy?.shouldRetry) return policy.shouldRetry(error, attempt);
  if (isPermanent(error)) return false;
  return true;
}

export function getMaxAttempts(policy: RetryPolicy | undefined): number {
  return policy?.maxAttempts ?? DEFAULTS.maxAttempts;
}
