import type { SerializedError } from './types.js';

/** Mark an error as permanently fatal — the executor must not retry it. */
export class PermanentError extends Error {
  readonly permanent = true as const;
  readonly code?: string;

  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message);
    this.name = 'PermanentError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    if (options?.code) this.code = options.code;
  }
}

/** Mark an error as transient — explicitly eligible for retry. */
export class TransientError extends Error {
  readonly transient = true as const;
  readonly code?: string;

  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message);
    this.name = 'TransientError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    if (options?.code) this.code = options.code;
  }
}

/** Thrown when a step exceeds its configured timeout. Retryable by default. */
export class StepTimeoutError extends Error {
  readonly timeout = true as const;

  constructor(
    public readonly stepName: string,
    public readonly timeoutMs: number,
  ) {
    super(`step "${stepName}" timed out after ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
  }
}

/** Thrown when execution is cancelled via AbortSignal. */
export class FlowAbortedError extends Error {
  readonly aborted = true as const;

  constructor(reason?: unknown) {
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'flow aborted';
    super(msg);
    this.name = 'FlowAbortedError';
    if (reason !== undefined) (this as { cause?: unknown }).cause = reason;
  }
}

/**
 * Thrown when the storage adapter cannot acquire a lock within the configured
 * wait timeout — typically because another worker is currently executing the
 * same idempotency key.
 */
export class LockAcquisitionError extends Error {
  constructor(
    public readonly flowName: string,
    public readonly flowId: string,
    reason?: string,
  ) {
    super(
      reason
        ? `failed to acquire lock for ${flowName}/${flowId}: ${reason}`
        : `failed to acquire lock for ${flowName}/${flowId}`,
    );
    this.name = 'LockAcquisitionError';
  }
}

/** Thrown by the executor when a step fails and compensation runs. */
export class FlowError extends Error {
  constructor(
    message: string,
    public readonly flowId: string,
    public readonly flowName: string,
    public readonly failedStep: string,
    public readonly originalError: unknown,
    public readonly compensationErrors: Array<{ step: string; error: unknown }> = [],
  ) {
    super(message);
    this.name = 'FlowError';
    (this as { cause?: unknown }).cause = originalError;
  }
}

/** Heuristic: errors are retryable unless explicitly marked permanent. */
export function isPermanent(err: unknown): boolean {
  return (
    err instanceof PermanentError ||
    (typeof err === 'object' && err !== null && (err as { permanent?: boolean }).permanent === true)
  );
}

export function isTransient(err: unknown): boolean {
  return (
    err instanceof TransientError ||
    err instanceof StepTimeoutError ||
    (typeof err === 'object' && err !== null && (err as { transient?: boolean }).transient === true)
  );
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    const withCode = err as { code?: unknown };
    if (typeof withCode.code === 'string') out.code = withCode.code;
    if (isTransient(err)) out.transient = true;
    return out;
  }
  return { name: 'UnknownError', message: String(err) };
}
