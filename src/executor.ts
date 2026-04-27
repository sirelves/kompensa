import type {
  FlowConfig,
  FlowHooks,
  FlowState,
  Lock,
  Logger,
  RetryPolicy,
  StepContext,
  StepDefinition,
  StepState,
  StorageAdapter,
  ExecuteOptions,
} from './types.js';

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 30 * 1000;
import { FlowAbortedError, FlowError, serializeError } from './errors.js';
import { computeDelay, getMaxAttempts, shouldRetryError } from './retry.js';
import { silentLogger } from './observability/logger.js';
import { invokeHook } from './observability/hooks.js';
import { MemoryStorage } from './storage/memory.js';
import { sleep } from './utils/sleep.js';
import { withTimeout } from './utils/timeout.js';
import { generateId } from './utils/id.js';

export interface RegisteredStep {
  name: string;
  /** `'sequential'` (default) or `'parallel'` for fan-out/fan-in groups. */
  kind?: 'sequential' | 'parallel';
  /**
   * For sequential steps this carries the step body. For parallel groups it is
   * `undefined` — the executor reads `branches`/`parallelOptions` instead.
   */
  definition: StepDefinition<unknown, Record<string, unknown>, unknown>;
  /**
   * Set only when `kind === 'parallel'`. Map of branch name → branch
   * definition (same shape as a regular step). The executor runs all branches
   * concurrently, persisting each one under `state.steps[i].branches[branchName]`.
   */
  branches?: Record<string, StepDefinition<unknown, Record<string, unknown>, unknown>>;
  /** Set only when `kind === 'parallel'`. Group-level options. */
  parallelOptions?: import('./types.js').ParallelGroupOptions;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function findFailedStepName(state: FlowState): string {
  const failed = state.steps.find((s) => s.status === 'failed' || s.status === 'compensated');
  return failed?.name ?? 'unknown';
}

function hydrateError(serialized?: FlowState['error']): Error {
  if (!serialized) return new Error('unknown error');
  const err = new Error(serialized.message);
  err.name = serialized.name;
  if (serialized.stack) err.stack = serialized.stack;
  return err;
}

function createInitialState(
  flowName: string,
  flowId: string,
  steps: RegisteredStep[],
  input: unknown,
  metadata: Record<string, unknown>,
): FlowState {
  const now = Date.now();
  return {
    flowName,
    flowId,
    status: 'pending',
    input,
    steps: steps.map<StepState>((s) =>
      s.kind === 'parallel'
        ? {
            name: s.name,
            status: 'pending',
            attempts: 0,
            kind: 'parallel',
            branches: Object.fromEntries(
              Object.keys(s.branches ?? {}).map((bn) => [
                bn,
                { name: bn, status: 'pending', attempts: 0 },
              ]),
            ),
          }
        : {
            name: s.name,
            status: 'pending',
            attempts: 0,
          },
    ),
    currentStepIndex: 0,
    metadata,
    createdAt: now,
    updatedAt: now,
  };
}

function buildContext<TInput>(args: {
  input: TInput;
  results: Record<string, unknown>;
  metadata: Record<string, unknown>;
  attempt: number;
  signal: AbortSignal;
  flowId: string;
  flowName: string;
  stepName: string;
  logger: Logger;
}): StepContext<TInput, Record<string, unknown>> {
  return {
    input: args.input,
    results: args.results,
    metadata: args.metadata,
    attempt: args.attempt,
    signal: args.signal,
    flowId: args.flowId,
    flowName: args.flowName,
    stepName: args.stepName,
    logger: args.logger,
  };
}

async function runSingleAttempt<TInput>(
  definition: StepDefinition<unknown, Record<string, unknown>, unknown>,
  unitName: string,
  ctx: StepContext<TInput, Record<string, unknown>>,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const exec = Promise.resolve().then(() =>
    (definition.run as (c: typeof ctx) => unknown | Promise<unknown>)(ctx),
  );
  if (timeoutMs && timeoutMs > 0) {
    return withTimeout(exec, timeoutMs, unitName);
  }
  return exec;
}

/**
 * Generalized retry loop used by both regular sequential steps and individual
 * branches inside a parallel group. The caller supplies the {@link StepState}
 * to mutate, the hook stepName (`group.branch` for branches), and a `persist`
 * callback that saves the parent {@link FlowState}.
 */
async function runUnitWithRetry<TInput>(args: {
  definition: StepDefinition<unknown, Record<string, unknown>, unknown>;
  hookStepName: string;
  stepIndex: number;
  unitState: import('./types.js').StepState;
  persist: () => Promise<void>;
  input: TInput;
  results: Record<string, unknown>;
  metadata: Record<string, unknown>;
  signal: AbortSignal;
  flowId: string;
  flowName: string;
  logger: Logger;
  hooks: FlowHooks | undefined;
  defaultRetry: RetryPolicy | undefined;
  defaultTimeout: number | undefined;
}): Promise<unknown> {
  const {
    definition,
    hookStepName,
    stepIndex,
    unitState,
    persist,
    input,
    results,
    metadata,
    signal,
    flowId,
    flowName,
    logger,
    hooks,
    defaultRetry,
    defaultTimeout,
  } = args;

  const policy = definition.retry ?? defaultRetry;
  const maxAttempts = Math.max(1, getMaxAttempts(policy));
  const timeout = definition.timeout ?? defaultTimeout;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw new FlowAbortedError(signal.reason);

    unitState.attempts = attempt;
    unitState.status = 'running';
    if (attempt === 1) unitState.startedAt = Date.now();
    await persist();

    const ctx = buildContext({
      input,
      results,
      metadata,
      attempt,
      signal,
      flowId,
      flowName,
      stepName: hookStepName,
      logger: logger.child?.({ stepName: hookStepName, attempt }) ?? logger,
    });

    await invokeHook(
      hooks,
      'onStepStart',
      { flowName, flowId, metadata, stepName: hookStepName, stepIndex, attempt },
      logger,
    );

    try {
      const result = await runSingleAttempt(definition, hookStepName, ctx, timeout);
      return result;
    } catch (err) {
      lastError = err;

      const isLastAttempt = attempt >= maxAttempts;
      const aborted = signal.aborted || err instanceof FlowAbortedError;
      const retryable = !aborted && !isLastAttempt && shouldRetryError(policy, err, attempt);

      if (!retryable) throw err;

      const delay = computeDelay(policy, attempt);
      await invokeHook(
        hooks,
        'onStepRetry',
        {
          flowName,
          flowId,
          metadata,
          stepName: hookStepName,
          stepIndex,
          attempt,
          error: err,
          nextDelayMs: delay,
        },
        logger,
      );

      await sleep(delay, signal);
    }
  }

  throw lastError;
}

/**
 * Derive a child AbortSignal that aborts when the parent aborts AND can be
 * aborted independently (used to fail-fast sibling branches when one fails).
 * Hand-rolled instead of `AbortSignal.any` for Node 18 compatibility.
 */
function deriveSignal(parent: AbortSignal): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
} {
  const ctrl = new AbortController();
  if (parent.aborted) {
    ctrl.abort(parent.reason);
  } else {
    parent.addEventListener('abort', () => ctrl.abort(parent.reason), { once: true });
  }
  return { signal: ctrl.signal, abort: (r) => ctrl.abort(r) };
}

/**
 * Run a parallel step group. Each branch executes concurrently with its own
 * retry loop. Branch state is persisted under `state.steps[stepIndex].branches[name]`
 * so crash recovery can resume only the branches that did not finish.
 *
 * Behavior:
 * - First failure aborts siblings via a derived signal when
 *   `abortOnFailure !== false` (the default).
 * - The whole group is wrapped in a `groupTimeout` if specified.
 * - Returns the merged `{ [branchName]: result }` object on success; throws
 *   the first branch error on failure (with surviving compensations handled
 *   by `runCompensation`).
 */
async function runParallelGroup<TInput>(args: {
  step: RegisteredStep;
  stepIndex: number;
  state: FlowState;
  input: TInput;
  results: Record<string, unknown>;
  metadata: Record<string, unknown>;
  signal: AbortSignal;
  flowId: string;
  flowName: string;
  logger: Logger;
  hooks: FlowHooks | undefined;
  defaultRetry: RetryPolicy | undefined;
  defaultTimeout: number | undefined;
  storage: StorageAdapter;
}): Promise<Record<string, unknown>> {
  const {
    step,
    stepIndex,
    state,
    input,
    results,
    metadata,
    signal,
    flowId,
    flowName,
    logger,
    hooks,
    defaultRetry,
    defaultTimeout,
    storage,
  } = args;

  if (!step.branches) {
    throw new Error(
      `kompensa: internal — parallel step "${step.name}" missing branches map`,
    );
  }
  const groupOpts = step.parallelOptions ?? {};
  const abortOnFailure = groupOpts.abortOnFailure !== false;

  const groupState = state.steps[stepIndex]!;
  groupState.kind = 'parallel';
  groupState.status = 'running';
  groupState.startedAt ??= Date.now();
  groupState.branches ??= {};

  const branchNames = Object.keys(step.branches);
  // Ensure every branch has its own StepState entry, even on first run.
  for (const bn of branchNames) {
    if (!groupState.branches[bn]) {
      groupState.branches[bn] = { name: bn, status: 'pending', attempts: 0 };
    }
  }
  await storage.save(state);

  const branchResults: Record<string, unknown> = {};
  // Pre-populate with cached results from previously successful branches so
  // crash recovery skips them.
  for (const bn of branchNames) {
    const bs = groupState.branches[bn]!;
    if (bs.status === 'success') {
      branchResults[bn] = bs.result;
    }
  }

  const persist = () => storage.save(state);
  const { signal: groupSignal, abort: abortGroup } = deriveSignal(signal);

  const branchPromises: Promise<void>[] = branchNames.map(async (branchName) => {
    const bs = groupState.branches![branchName]!;
    if (bs.status === 'success') return; // resume — already done

    const definition = step.branches![branchName]!;
    const hookStepName = `${step.name}.${branchName}`;
    const branchStart = Date.now();

    try {
      const result = await runUnitWithRetry({
        definition,
        hookStepName,
        stepIndex,
        unitState: bs,
        persist,
        input,
        results,
        metadata,
        signal: groupSignal,
        flowId,
        flowName,
        logger,
        hooks,
        defaultRetry,
        defaultTimeout,
      });
      bs.status = 'success';
      bs.result = result;
      bs.endedAt = Date.now();
      branchResults[branchName] = result;
      await persist();

      await invokeHook(
        hooks,
        'onStepEnd',
        {
          flowName,
          flowId,
          metadata,
          stepName: hookStepName,
          stepIndex,
          status: 'success',
          attempts: bs.attempts,
          durationMs: Date.now() - branchStart,
          result,
        },
        logger,
      );
    } catch (err) {
      bs.status = 'failed';
      bs.error = serializeError(err);
      bs.endedAt = Date.now();
      await persist();

      await invokeHook(
        hooks,
        'onStepEnd',
        {
          flowName,
          flowId,
          metadata,
          stepName: hookStepName,
          stepIndex,
          status: 'failed',
          attempts: bs.attempts,
          durationMs: Date.now() - branchStart,
          error: err,
        },
        logger,
      );

      if (abortOnFailure) abortGroup(err);
      throw err;
    }
  });

  const allBranches = Promise.allSettled(branchPromises);
  const settled = groupOpts.groupTimeout
    ? await withTimeout(allBranches, groupOpts.groupTimeout, step.name)
    : await allBranches;

  // Aggregate `attempts` on the group as the max across branches so callers
  // see a meaningful number even when only some branches retried.
  groupState.attempts = Math.max(
    1,
    ...branchNames.map((bn) => groupState.branches![bn]?.attempts ?? 1),
  );

  const failures = settled
    .map((r, idx) => ({ result: r, name: branchNames[idx]! }))
    .filter((x) => x.result.status === 'rejected') as Array<{
    result: PromiseRejectedResult;
    name: string;
  }>;

  if (failures.length === 0) {
    return branchResults;
  }

  // Surface the first failure as the canonical error. Other failures remain
  // visible via per-branch `error` fields in persisted state.
  const first = failures[0]!;
  throw first.result.reason;
}

/** Compensate a single unit (a regular step or one branch of a parallel group). */
async function compensateUnit<TInput>(args: {
  definition: StepDefinition<unknown, Record<string, unknown>, unknown>;
  hookStepName: string;
  stepIndex: number;
  unitState: import('./types.js').StepState;
  persist: () => Promise<void>;
  input: TInput;
  results: Record<string, unknown>;
  metadata: Record<string, unknown>;
  signal: AbortSignal;
  flowId: string;
  flowName: string;
  logger: Logger;
  hooks: FlowHooks | undefined;
}): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const {
    definition,
    hookStepName,
    stepIndex,
    unitState,
    persist,
    input,
    results,
    metadata,
    signal,
    flowId,
    flowName,
    logger,
    hooks,
  } = args;

  if (!definition.compensate) return { ok: true };
  if (unitState.status !== 'success') return { ok: true };

  unitState.status = 'compensating';
  await persist();
  await invokeHook(
    hooks,
    'onCompensate',
    { flowName, flowId, metadata, stepName: hookStepName, stepIndex, status: 'compensating' },
    logger,
  );

  const ctx = buildContext({
    input,
    results,
    metadata,
    attempt: 1,
    signal,
    flowId,
    flowName,
    stepName: hookStepName,
    logger: logger.child?.({ stepName: hookStepName, phase: 'compensate' }) ?? logger,
  });

  try {
    await (definition.compensate as (c: typeof ctx, r: unknown) => unknown | Promise<unknown>)(
      ctx,
      unitState.result,
    );
    unitState.status = 'compensated';
    await persist();
    await invokeHook(
      hooks,
      'onCompensate',
      { flowName, flowId, metadata, stepName: hookStepName, stepIndex, status: 'compensated' },
      logger,
    );
    return { ok: true };
  } catch (err) {
    unitState.compensationError = serializeError(err);
    await persist();
    await invokeHook(
      hooks,
      'onCompensate',
      {
        flowName,
        flowId,
        metadata,
        stepName: hookStepName,
        stepIndex,
        status: 'failed',
        error: err,
      },
      logger,
    );
    return { ok: false, error: err };
  }
}

async function runCompensation<TInput>(args: {
  steps: RegisteredStep[];
  state: FlowState;
  results: Record<string, unknown>;
  input: TInput;
  metadata: Record<string, unknown>;
  logger: Logger;
  hooks: FlowHooks | undefined;
  flowId: string;
  flowName: string;
  signal: AbortSignal;
  storage: StorageAdapter;
}): Promise<Array<{ step: string; error: unknown }>> {
  const { steps, state, results, input, metadata, logger, hooks, flowId, flowName, signal, storage } =
    args;
  const errors: Array<{ step: string; error: unknown }> = [];
  const persist = () => storage.save(state);

  for (let i = state.currentStepIndex; i >= 0; i--) {
    const step = steps[i];
    const stepState = state.steps[i];
    if (!step || !stepState) continue;

    // ---- Parallel group compensation ----
    if (step.kind === 'parallel' && step.branches && stepState.branches) {
      // Only compensate branches that actually succeeded.
      const successful = Object.entries(stepState.branches).filter(
        ([, bs]) => bs.status === 'success',
      );
      if (successful.length === 0) continue;

      const compensateSerially = step.parallelOptions?.compensateSerially === true;
      const ordered = compensateSerially
        ? // Reverse-completion-order rollback: branch that finished last is
          // compensated first (LIFO on causal chain).
          [...successful].sort(([, a], [, b]) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
        : successful;

      stepState.status = 'compensating';
      await persist();

      const compensateOne = async (branchName: string) => {
        const bs = stepState.branches![branchName]!;
        const def = step.branches![branchName]!;
        const result = await compensateUnit({
          definition: def,
          hookStepName: `${step.name}.${branchName}`,
          stepIndex: i,
          unitState: bs,
          persist,
          input,
          results,
          metadata,
          signal,
          flowId,
          flowName,
          logger,
          hooks,
        });
        if (!result.ok) {
          errors.push({ step: `${step.name}.${branchName}`, error: result.error });
        }
      };

      if (compensateSerially) {
        for (const [bn] of ordered) {
          await compensateOne(bn);
        }
      } else {
        await Promise.allSettled(ordered.map(([bn]) => compensateOne(bn)));
      }

      // Group status: compensated when every successful branch is compensated;
      // otherwise leave 'compensating' so observers can see partial rollback.
      const allCompensated = Object.values(stepState.branches).every(
        (bs) => bs.status !== 'success',
      );
      if (allCompensated) stepState.status = 'compensated';
      await persist();
      continue;
    }

    // ---- Sequential step compensation ----
    if (stepState.status !== 'success') continue;
    const result = await compensateUnit({
      definition: step.definition,
      hookStepName: step.name,
      stepIndex: i,
      unitState: stepState,
      persist,
      input,
      results,
      metadata,
      signal,
      flowId,
      flowName,
      logger,
      hooks,
    });
    if (!result.ok) {
      errors.push({ step: step.name, error: result.error });
    }
  }

  return errors;
}

export async function executeFlow<TInput, TResults extends object>(args: {
  flowName: string;
  steps: RegisteredStep[];
  input: TInput;
  config: FlowConfig;
  options: ExecuteOptions;
}): Promise<TResults> {
  const { flowName, steps, input, config, options } = args;
  const startTime = Date.now();

  const storage = config.storage ?? new MemoryStorage();
  const baseLogger = config.logger ?? silentLogger;
  const hooks = config.hooks;
  const defaultRetry = config.defaultRetry;
  const defaultTimeout = options.timeout ?? config.defaultTimeout;
  const signal = options.signal ?? new AbortController().signal;
  const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };

  const flowId = options.idempotencyKey ?? generateId(flowName);
  const logger = baseLogger.child?.({ flowName, flowId }) ?? baseLogger;

  // Acquire an exclusive lock for the (flowName, flowId) pair when the storage
  // adapter supports it. This prevents two workers from racing on the same
  // idempotency key. If the adapter doesn't implement acquireLock we fall
  // through — safe for single-process deployments like MemoryStorage in tests.
  const lockTtlMs = config.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const lockWaitMs = config.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  let lock: Lock | null = null;
  if (storage.acquireLock) {
    lock = await storage.acquireLock(flowName, flowId, {
      ttlMs: lockTtlMs,
      timeoutMs: lockWaitMs,
    });
  }

  try {
    return await runExecution<TInput, TResults>({
      flowName,
      flowId,
      steps,
      input,
      config,
      options,
      storage,
      logger,
      hooks,
      defaultRetry,
      defaultTimeout,
      signal,
      metadata,
      startTime,
    });
  } finally {
    if (lock) {
      try {
        await lock.release();
      } catch (err) {
        logger.warn('lock release failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

interface RunExecutionArgs<TInput> {
  flowName: string;
  flowId: string;
  steps: RegisteredStep[];
  input: TInput;
  config: FlowConfig;
  options: ExecuteOptions;
  storage: StorageAdapter;
  logger: Logger;
  hooks: FlowHooks | undefined;
  defaultRetry: RetryPolicy | undefined;
  defaultTimeout: number | undefined;
  signal: AbortSignal;
  metadata: Record<string, unknown>;
  startTime: number;
}

async function runExecution<TInput, TResults extends object>(
  args: RunExecutionArgs<TInput>,
): Promise<TResults> {
  const {
    flowName,
    flowId,
    steps,
    input,
    storage,
    logger,
    hooks,
    defaultRetry,
    defaultTimeout,
    signal,
    metadata,
    startTime,
  } = args;

  let state = await storage.load(flowName, flowId);

  // Short-circuit: already succeeded → return cached result.
  if (state?.status === 'success') {
    logger.debug('flow already succeeded, returning cached result');
    return (state.result ?? {}) as TResults;
  }

  // Already compensated → re-throw historical failure instead of re-running.
  if (state?.status === 'compensated' || state?.status === 'failed') {
    const err = hydrateError(state.error);
    throw new FlowError(
      `flow "${flowName}" previously ${state.status}: ${err.message}`,
      flowId,
      flowName,
      findFailedStepName(state),
      err,
    );
  }

  const resumed = !!state;
  if (!state) {
    state = createInitialState(flowName, flowId, steps, input, metadata);
  } else {
    // Resume path: keep original input, merge metadata.
    state.status = 'running';
    state.metadata = { ...state.metadata, ...metadata };
    state.updatedAt = Date.now();
    // Keep state.input as the original — resume must be deterministic.
  }
  state.status = 'running';
  await storage.save(state);

  // Rebuild results map from previously successful steps.
  const results: Record<string, unknown> = {};
  for (const s of state.steps) {
    if (s.status === 'success' || s.status === 'skipped') {
      results[s.name] = s.result;
    }
  }

  // Resume from the first non-complete step.
  const firstIncomplete = state.steps.findIndex(
    (s) => s.status !== 'success' && s.status !== 'skipped',
  );
  const startIndex = firstIncomplete === -1 ? state.steps.length : firstIncomplete;

  await invokeHook(
    hooks,
    'onFlowStart',
    { flowName, flowId, metadata, input: state.input, resumed },
    logger,
  );

  const effectiveInput = state.input as TInput;

  try {
    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i]!;
      const stepState = state.steps[i]!;
      state.currentStepIndex = i;

      const stepStart = Date.now();
      try {
        if (signal.aborted) throw new FlowAbortedError(signal.reason);

        // skipIf check
        if (step.definition.skipIf) {
          const skipCtx = buildContext({
            input: effectiveInput,
            results,
            metadata,
            attempt: 0,
            signal,
            flowId,
            flowName,
            stepName: step.name,
            logger: logger.child?.({ stepName: step.name }) ?? logger,
          });
          const skip = await step.definition.skipIf(skipCtx);
          if (skip) {
            stepState.status = 'skipped';
            stepState.startedAt = Date.now();
            stepState.endedAt = Date.now();
            await storage.save(state);
            await invokeHook(
              hooks,
              'onStepEnd',
              {
                flowName,
                flowId,
                metadata,
                stepName: step.name,
                stepIndex: i,
                status: 'skipped',
                attempts: 0,
                durationMs: 0,
              },
              logger,
            );
            continue;
          }
        }

        let result: unknown;
        if (step.kind === 'parallel') {
          result = await runParallelGroup({
            step,
            stepIndex: i,
            state,
            input: effectiveInput,
            results,
            metadata,
            signal,
            flowId,
            flowName,
            logger,
            hooks,
            defaultRetry,
            defaultTimeout,
            storage,
          });
        } else {
          result = await runUnitWithRetry({
            definition: step.definition,
            hookStepName: step.name,
            stepIndex: i,
            unitState: stepState,
            persist: () => storage.save(state),
            input: effectiveInput,
            results,
            metadata,
            signal,
            flowId,
            flowName,
            logger,
            hooks,
            defaultRetry,
            defaultTimeout,
          });
        }

        stepState.status = 'success';
        stepState.result = result;
        stepState.endedAt = Date.now();
        results[step.name] = result;
        await storage.save(state);

        await invokeHook(
          hooks,
          'onStepEnd',
          {
            flowName,
            flowId,
            metadata,
            stepName: step.name,
            stepIndex: i,
            status: 'success',
            attempts: stepState.attempts,
            durationMs: Date.now() - stepStart,
            result,
          },
          logger,
        );
      } catch (err) {
        stepState.status = 'failed';
        stepState.error = serializeError(err);
        stepState.endedAt = Date.now();
        state.status = 'compensating';
        await storage.save(state);

        await invokeHook(
          hooks,
          'onStepEnd',
          {
            flowName,
            flowId,
            metadata,
            stepName: step.name,
            stepIndex: i,
            status: 'failed',
            attempts: stepState.attempts,
            durationMs: Date.now() - stepStart,
            error: err,
          },
          logger,
        );

        const compensationErrors = await runCompensation({
          steps,
          state,
          results,
          input: effectiveInput,
          metadata,
          logger,
          hooks,
          flowId,
          flowName,
          signal,
          storage,
        });

        const finalStatus = err instanceof FlowAbortedError ? 'failed' : 'compensated';
        state.status = finalStatus;
        state.error = serializeError(err);
        state.updatedAt = Date.now();
        await storage.save(state);

        const flowErr = new FlowError(
          `flow "${flowName}" failed at step "${step.name}": ${errorMessage(err)}`,
          flowId,
          flowName,
          step.name,
          err,
          compensationErrors,
        );

        await invokeHook(
          hooks,
          'onFlowEnd',
          {
            flowName,
            flowId,
            metadata,
            status: finalStatus,
            error: flowErr,
            durationMs: Date.now() - startTime,
          },
          logger,
        );

        throw flowErr;
      }
    }

    state.status = 'success';
    state.result = results;
    state.updatedAt = Date.now();
    await storage.save(state);

    await invokeHook(
      hooks,
      'onFlowEnd',
      {
        flowName,
        flowId,
        metadata,
        status: 'success',
        results,
        durationMs: Date.now() - startTime,
      },
      logger,
    );

    return results as TResults;
  } catch (err) {
    if (err instanceof FlowError) throw err;
    // Unexpected error path (e.g. abort before any step). Persist and rethrow.
    state.status = 'failed';
    state.error = serializeError(err);
    state.updatedAt = Date.now();
    await storage.save(state);
    await invokeHook(
      hooks,
      'onFlowEnd',
      {
        flowName,
        flowId,
        metadata,
        status: 'failed',
        error: err,
        durationMs: Date.now() - startTime,
      },
      logger,
    );
    throw err;
  }
}
