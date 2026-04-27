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
 *
 * For parallel step groups (created via {@link Flow.parallel}), each branch is
 * persisted under `branches[branchName]` as its own {@link StepState}. The
 * group itself uses the same `name`, `status`, `attempts` (= max across
 * branches), and timestamps as a regular step. Single steps leave `branches`
 * undefined — the field is purely additive and existing persisted states load
 * unchanged.
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
  /**
   * Set only for parallel step groups. Map of branch name → branch state.
   * Absent on regular sequential steps for backwards compatibility with
   * persisted state written by kompensa &lt; 0.3.
   */
  branches?: Record<string, StepState>;
  /**
   * Marks this step as a parallel group. Useful when reading persisted state
   * to distinguish a group from a regular step that happens to have no
   * branches recorded yet. Absent on regular sequential steps.
   */
  kind?: 'sequential' | 'parallel';
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
 * Definition of a single branch inside a parallel step group. Identical to
 * {@link StepDefinition} except the branch name is the object key in the group
 * map rather than a separate argument.
 *
 * @internal — exposed via {@link ParallelStepDefinition}.
 */
export type ParallelBranchDefinition<TInput, TResults, TResult> = Omit<
  StepDefinition<TInput, TResults, TResult>,
  never
>;

/**
 * Map of branch name → branch definition. Used by {@link Flow.parallel}.
 * The TypeScript inference machinery picks each branch's result type from its
 * `run` return value, so `ctx.results.<groupName>.<branchName>` is fully typed
 * in downstream steps.
 */
export type ParallelStepDefinition<
  TInput,
  TResults,
  TBranches extends Record<string, ParallelBranchDefinition<TInput, TResults, unknown>>,
> = TBranches & {
  /**
   * Optional group-level timeout in milliseconds. When set, the entire group
   * (all branches) must complete within this window or the group fails with a
   * {@link StepTimeoutError}. Per-branch `timeout` still applies independently.
   */
  // Note: branches are nominal keys — this object never carries options of its
  // own at the type level. Options are passed via the second argument of
  // Flow.parallel(name, branches, options).
};

/**
 * Options for a parallel step group, passed as the third argument of
 * {@link Flow.parallel}.
 */
export interface ParallelGroupOptions {
  /**
   * Group-level timeout in milliseconds. The group fails if all branches do
   * not settle within this window. Per-branch `timeout` still applies. Default:
   * undefined (no group-level timeout, only per-branch timeouts apply).
   */
  groupTimeout?: number;
  /**
   * When `true`, compensation of branches in this group runs sequentially in
   * the reverse order branches completed. When `false` (default), compensation
   * runs in parallel via Promise.allSettled. Use sequential compensation only
   * when there is a causal dependency between branches that requires ordering.
   */
  compensateSerially?: boolean;
  /**
   * When `true` (default), if any branch fails the group aborts the remaining
   * branches via the shared AbortSignal. When `false`, all branches run to
   * completion regardless of sibling failures (failures are still surfaced).
   * Fail-fast is the recommended default; disable only for observability or
   * when branches are fully independent.
   */
  abortOnFailure?: boolean;
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
 * Handle returned by {@link StorageAdapter.acquireLock}. Call `release` when
 * done to free the lock. Safe to call multiple times; subsequent calls are
 * no-ops. `refresh` extends the TTL if the adapter supports it.
 */
export interface Lock {
  release(): Promise<void>;
  refresh?(): Promise<void>;
}

/**
 * Options for {@link StorageAdapter.acquireLock}.
 */
export interface AcquireLockOptions {
  /** Lock expiration in milliseconds. Set >= max expected execution time. */
  ttlMs: number;
  /** Max time to wait for the lock. `0` fails fast; default 30_000. */
  timeoutMs: number;
}

/**
 * Storage adapter contract. Implementations persist flow state so executions
 * can be resumed, deduplicated, and observed.
 *
 * `acquireLock` is optional but **strongly recommended** for adapters used in
 * multi-worker deployments. Without it, two workers handling the same
 * `idempotencyKey` will both execute the flow concurrently.
 */
export interface StorageAdapter {
  load(flowName: string, flowId: string): Promise<FlowState | null>;
  save(state: FlowState): Promise<void>;
  delete?(flowName: string, flowId: string): Promise<void>;
  acquireLock?(
    flowName: string,
    flowId: string,
    options: AcquireLockOptions,
  ): Promise<Lock>;
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
  /**
   * Lock TTL for this flow in ms. Only applies when the storage adapter
   * implements `acquireLock`. Default: 5 minutes.
   */
  lockTtlMs?: number;
  /**
   * How long to wait for the lock before giving up. `0` fails immediately if
   * the lock is held. Default: 30 seconds.
   */
  lockWaitMs?: number;
}
