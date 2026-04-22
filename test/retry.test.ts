import { describe, it, expect } from 'vitest';
import { computeDelay, shouldRetryError, getMaxAttempts } from '../src/retry.js';
import { PermanentError, TransientError } from '../src/errors.js';

describe('computeDelay', () => {
  it('fixed backoff returns initialDelayMs', () => {
    const d1 = computeDelay({ backoff: 'fixed', initialDelayMs: 100, jitter: false }, 1);
    const d2 = computeDelay({ backoff: 'fixed', initialDelayMs: 100, jitter: false }, 5);
    expect(d1).toBe(100);
    expect(d2).toBe(100);
  });

  it('linear backoff scales with attempt', () => {
    const d1 = computeDelay({ backoff: 'linear', initialDelayMs: 100, jitter: false }, 1);
    const d3 = computeDelay({ backoff: 'linear', initialDelayMs: 100, jitter: false }, 3);
    expect(d1).toBe(100);
    expect(d3).toBe(300);
  });

  it('exponential backoff with multiplier 2', () => {
    const opts = { backoff: 'exponential' as const, initialDelayMs: 100, jitter: false };
    expect(computeDelay(opts, 1)).toBe(100);
    expect(computeDelay(opts, 2)).toBe(200);
    expect(computeDelay(opts, 3)).toBe(400);
    expect(computeDelay(opts, 4)).toBe(800);
  });

  it('caps at maxDelayMs', () => {
    const d = computeDelay(
      { backoff: 'exponential', initialDelayMs: 100, maxDelayMs: 500, jitter: false },
      10,
    );
    expect(d).toBe(500);
  });

  it('applies jitter within expected range', () => {
    const base = 1000;
    for (let i = 0; i < 50; i++) {
      const d = computeDelay(
        { backoff: 'fixed', initialDelayMs: base, jitter: true },
        1,
      );
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(base);
    }
  });

  it('jitter fraction narrows the random range', () => {
    const base = 1000;
    for (let i = 0; i < 50; i++) {
      const d = computeDelay(
        { backoff: 'fixed', initialDelayMs: base, jitter: 0.1 },
        1,
      );
      expect(d).toBeGreaterThanOrEqual(base * 0.9);
      expect(d).toBeLessThanOrEqual(base);
    }
  });
});

describe('shouldRetryError', () => {
  it('returns false for PermanentError', () => {
    expect(shouldRetryError(undefined, new PermanentError('nope'), 1)).toBe(false);
  });

  it('returns true for TransientError', () => {
    expect(shouldRetryError(undefined, new TransientError('yes'), 1)).toBe(true);
  });

  it('returns true for generic Error by default', () => {
    expect(shouldRetryError(undefined, new Error('??'), 1)).toBe(true);
  });

  it('defers to user predicate when provided', () => {
    const policy = { shouldRetry: () => false };
    expect(shouldRetryError(policy, new TransientError('t'), 1)).toBe(false);
  });
});

describe('getMaxAttempts', () => {
  it('defaults to 1', () => {
    expect(getMaxAttempts(undefined)).toBe(1);
    expect(getMaxAttempts({})).toBe(1);
  });

  it('honors configured value', () => {
    expect(getMaxAttempts({ maxAttempts: 7 })).toBe(7);
  });
});
