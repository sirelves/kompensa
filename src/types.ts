/**
 * Lifecycle states for an individual step within a flow.
 *
 * pending → running → (success | failed | compensating → compensated | skipped)
 */
export type StepStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'compensating'
  | 'compensated'
  | 'skipped';

/**
 * Lifecycle states for a flow execution.
 *
 * pending → running → (success | failed | compensating → compensated)
 */
export type FlowStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'compensating'
  | 'compensated';

/**
 * Serializable error shape stored in flow state. Full Error objects can't be
 * safely persisted because stack traces and prototypes are lost on clone.
 */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  transient?: boolean;
}

/**
 * Persisted state for a single step execution. Written to storage after every
 * transition so crashed executions can resume from the last successful step.
 */
export interface StepState {
  name: string;
  status: StepStatus;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  result?: unknown;
  error?: SerializedError;
  compensationError?: SerializedError;
}

/**
 * Persisted state for an entire flow execution. Keyed by (flowName, flowId).
 */
export interface FlowState<TInput = unknown, TResults = Record<string, unknown>> {
  flowName: string;
  flowId: string;
  status: FlowStatus;
  input: TInput;
  steps: StepState[];
  currentStepIndex: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  result?: TResults;
  error?: SerializedError;
}

/**
 * Retry policy controlling how many times a failing step is retried and how
 * delays are computed between attempts.
 */
export interface RetryPolicy {
  /** Total attempts including the first try. Default: 1 (no retries). */
  maxAttempts?: number;
  /** Curve applied to the delay across attempts. Default: `exponential`. */
  backoff?: 'fixed' | 'linear' | 'exponential';
  /** Delay before the second attempt in milliseconds. Default: 100. */
  initialDelayMs?: number;
  /** Cap applied to any computed delay. Default: 30000. */
  maxDelayMs?: number;
  /** Growth factor for exponential backoff. Default: 2. */
  multiplier?: number;
  /**
   * Random jitter applied to delays. `true` means ±100% randomization;
   * a number between 0 and 1 caps the jitter fraction. Default: `true`.
   */
  jitter?: boolean | number;
  /**
   * Decide whether a given error should trigger another attempt. Overrides
   * the default behavior (retry on everything that isn't a PermanentError).
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Context passed to every step `run` and `compensate` function. Includes the
 * original input, accumulated step results, per-step metadata, and signals for
 * cancellation.
 */
export interface StepContext<TInput, TResults> {
  input: TInput;
  results: TResults;
  metadata: Record<string, unknown>;
  attempt: number;
  signal: AbortSignal;
  flowId: string;
  flowName: string;
  stepName: string;
  logger: Logger;
}

/**
 * Definition of a single step. `run` produces a result; `compensate` is the
 * semantic inverse invoked on downstream failure.
 */
export interface StepDefinition<TInput, TResults, TResult> {
  run: (ctx: StepContext<TInput, TResults>) => TResult | Promise<TResult>;
  compensate?: (
    ctx: StepContext<TInput, TResults>,
    result: TResult,
  ) => void | Promise<void>;
  retry?: RetryPolicy;
  /** Step timeout in milliseconds. Overrides flow-level default. */
  timeout?: number;
  /** Skip this step when the predicate returns true. */
  skipIf?: (ctx: StepContext<TInput, TResults>) => boolean | Promise<boolean>;
}

/**
 * Options accepted by Flow.execute.
 */
export interface ExecuteOptions {
  /**
   * Unique key identifying this execution. Re-running with the same key
   * returns the cached result (if succeeded) or resumes from the last
   * successful step (if interrupted).
   */
  idempotencyKey?: string;
  /** Abort the execution mid-flight. Respected between steps and during retry delays. */
  signal?: AbortSignal;
  /** Free-form metadata available to all steps and hooks. */
  metadata?: Record<string, unknown>;
  /** Default timeout applied to steps without their own. */
  timeout?: number;
}

/**
 * Minimal structured logger interface. Any subset of the levels may be
 * implemented; missing methods are silently ignored.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child?(meta: Record<string, unknown>): Logger;
}

// ---------- Hook events ----------

export interface FlowEventBase {
  flowName: string;
  flowId: string;
  metadata: Record<string, unknown>;
}

export interface FlowStartEvent<TInput = unknown> extends FlowEventBase {
  input: TInput;
  resumed: boolean;
}

export interface FlowEndEvent<TResults = Record<string, unknown>>
  extends FlowEventBase {
  status: FlowStatus;
  results?: TResults;
  error?: unknown;
  durationMs: number;
}

export interface StepStartEvent extends FlowEventBase {
  stepName: string;
  stepIndex: number;
  attempt: number;
}

export interface StepRetryEvent extends FlowEventBase {
  stepName: string;
  stepIndex: number;
  attempt: number;
  error: unknown;
  nextDelayMs: number;
}

export interface StepEndEvent extends FlowEventBase {
  stepName: string;
  stepIndex: number;
  status: StepStatus;
  attempts: number;
  durationMs: number;
  result?: unknown;
  error?: unknown;
}

export interface CompensateEvent extends FlowEventBase {
  stepName: string;
  stepIndex: number;
  status: 'compensating' | 'compensated' | 'failed';
  error?: unknown;
}

/**
 * Optional lifecycle callbacks. All methods are called sequentially and may be
 * async; hook errors are logged but never interrupt the flow.
 */
export interface FlowHooks {
  onFlowStart?(event: FlowStartEvent): void | Promise<void>;
  onFlowEnd?(event: FlowEndEvent): void | Promise<void>;
  onStepStart?(event: StepStartEvent): void | Promise<void>;
  onStepRetry?(event: StepRetryEvent): void | Promise<void>;
  onStepEnd?(event: StepEndEvent): void | Promise<void>;
  onCompensate?(event: CompensateEvent): void | Promise<void>;
}

/**
 * Storage adapter contract. Implementations persist flow state so executions
 * can be resumed, deduplicated, and observed.
 */
export interface StorageAdapter {
  load(flowName: string, flowId: string): Promise<FlowState | null>;
  save(state: FlowState): Promise<void>;
  delete?(flowName: string, flowId: string): Promise<void>;
}

/**
 * Configuration injected into every flow. All ports are pluggable.
 */
export interface FlowConfig {
  storage?: StorageAdapter;
  logger?: Logger;
  hooks?: FlowHooks;
  defaultRetry?: RetryPolicy;
  defaultTimeout?: number;
}
