import type {
  FlowConfig,
  FlowHooks,
  FlowState,
  Logger,
  RetryPolicy,
  StepContext,
  StepDefinition,
  StepState,
  StorageAdapter,
  ExecuteOptions,
} from './types.js';
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
  definition: StepDefinition<unknown, Record<string, unknown>, unknown>;
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
  stepNames: string[],
  input: unknown,
  metadata: Record<string, unknown>,
): FlowState {
  const now = Date.now();
  return {
    flowName,
    flowId,
    status: 'pending',
    input,
    steps: stepNames.map<StepState>((name) => ({
      name,
      status: 'pending',
      attempts: 0,
    })),
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
  step: RegisteredStep,
  ctx: StepContext<TInput, Record<string, unknown>>,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const exec = Promise.resolve().then(() =>
    (step.definition.run as (c: typeof ctx) => unknown | Promise<unknown>)(ctx),
  );
  if (timeoutMs && timeoutMs > 0) {
    return withTimeout(exec, timeoutMs, step.name);
  }
  return exec;
}

async function runStepWithRetry<TInput>(args: {
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
}): Promise<unknown> {
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

  const policy = step.definition.retry ?? defaultRetry;
  const maxAttempts = Math.max(1, getMaxAttempts(policy));
  const timeout = step.definition.timeout ?? defaultTimeout;
  const stepState = state.steps[stepIndex]!;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw new FlowAbortedError(signal.reason);

    stepState.attempts = attempt;
    stepState.status = 'running';
    if (attempt === 1) stepState.startedAt = Date.now();
    await storage.save(state);

    const ctx = buildContext({
      input,
      results,
      metadata,
      attempt,
      signal,
      flowId,
      flowName,
      stepName: step.name,
      logger: logger.child?.({ stepName: step.name, attempt }) ?? logger,
    });

    await invokeHook(
      hooks,
      'onStepStart',
      { flowName, flowId, metadata, stepName: step.name, stepIndex, attempt },
      logger,
    );

    try {
      const result = await runSingleAttempt(step, ctx, timeout);
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
          stepName: step.name,
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

  for (let i = state.currentStepIndex; i >= 0; i--) {
    const step = steps[i];
    const stepState = state.steps[i];
    if (!step || !stepState) continue;
    if (!step.definition.compensate) continue;
    if (stepState.status !== 'success') continue;

    stepState.status = 'compensating';
    await storage.save(state);
    await invokeHook(
      hooks,
      'onCompensate',
      { flowName, flowId, metadata, stepName: step.name, stepIndex: i, status: 'compensating' },
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
      stepName: step.name,
      logger: logger.child?.({ stepName: step.name, phase: 'compensate' }) ?? logger,
    });

    try {
      await (step.definition.compensate as (c: typeof ctx, r: unknown) => unknown | Promise<unknown>)(
        ctx,
        stepState.result,
      );
      stepState.status = 'compensated';
      await storage.save(state);
      await invokeHook(
        hooks,
        'onCompensate',
        { flowName, flowId, metadata, stepName: step.name, stepIndex: i, status: 'compensated' },
        logger,
      );
    } catch (err) {
      stepState.compensationError = serializeError(err);
      errors.push({ step: step.name, error: err });
      await storage.save(state);
      await invokeHook(
        hooks,
        'onCompensate',
        {
          flowName,
          flowId,
          metadata,
          stepName: step.name,
          stepIndex: i,
          status: 'failed',
          error: err,
        },
        logger,
      );
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
    state = createInitialState(
      flowName,
      flowId,
      steps.map((s) => s.name),
      input,
      metadata,
    );
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

        const result = await runStepWithRetry({
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
