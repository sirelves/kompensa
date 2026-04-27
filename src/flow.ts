import type {
  ExecuteOptions,
  FlowConfig,
  ParallelBranchDefinition,
  ParallelGroupOptions,
  StepDefinition,
} from './types.js';
import { executeFlow, type RegisteredStep } from './executor.js';

/**
 * Compute the result type of a parallel group from its branches map.
 * For a branches object `{ a: { run: () => A }, b: { run: () => B } }`
 * the inferred type is `{ a: A; b: B }`. Promise return types are unwrapped
 * to match the final `ctx.results.<group>.<branch>` value.
 */
type Awaited2<T> = T extends Promise<infer U> ? U : T;
type ParallelBranchResults<TBranches> = {
  [K in keyof TBranches]: TBranches[K] extends { run: (...args: never[]) => infer R }
    ? Awaited2<R>
    : never;
};

/**
 * A Flow is a typed, ordered list of steps. The result type accumulates as
 * steps are added, so each subsequent step's `ctx.results` is statically
 * typed with every prior step's return value.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type EmptyResults = {};

export class Flow<TInput, TResults extends object = EmptyResults> {
  private readonly _steps: RegisteredStep[] = [];

  constructor(
    public readonly name: string,
    public readonly config: FlowConfig = {},
  ) {}

  /**
   * Append a step. The step's return value is accumulated into TResults so
   * every downstream step's `ctx.results.<name>` is statically typed.
   *
   * Duplicate step names are rejected at runtime (Flow.step will throw).
   */
  step<TName extends string, TResult>(
    name: TName,
    definition: StepDefinition<TInput, TResults, TResult>,
  ): Flow<TInput, TResults & { [K in TName]: TResult }> {
    if (this._steps.some((s) => s.name === name)) {
      throw new Error(`kompensa: duplicate step name "${String(name)}" in flow "${this.name}"`);
    }
    this._steps.push({
      name: name,
      definition: definition as unknown as RegisteredStep['definition'],
    });
    return this as unknown as Flow<TInput, TResults & { [K in TName]: TResult }>;
  }

  /**
   * Append a parallel step group (fan-out / fan-in). Each branch runs
   * concurrently via `Promise.all`. Results merge into a single object keyed
   * by branch name and become available downstream as
   * `ctx.results.<groupName>.<branchName>`, fully typed.
   *
   * Behavior:
   * - Branches run concurrently. By default, the first failing branch aborts
   *   its siblings via a shared `AbortSignal` (`abortOnFailure: true`).
   * - Compensation runs in parallel by default. Pass
   *   `{ compensateSerially: true }` when there is a causal dependency
   *   between branches that requires reverse-order rollback.
   * - Per-branch `retry`, `timeout`, and `compensate` work exactly like a
   *   regular step. A group-level `groupTimeout` bounds the entire group.
   * - Crash recovery resumes only branches that did not finish — already
   *   `success` branches are skipped, just like sequential steps.
   *
   * @example
   * createFlow<{ orderId: string }>('checkout')
   *   .parallel('externals', {
   *     pricing:  { run: (ctx) => api.pricing(ctx.input.orderId) },
   *     shipping: { run: (ctx) => api.shipping(ctx.input.orderId) },
   *     tax:      { run: (ctx) => api.tax(ctx.input.orderId), retry: { maxAttempts: 3 } },
   *   })
   *   .step('charge', {
   *     run: (ctx) => charge(ctx.results.externals.pricing.amount),
   *   })
   */
  parallel<
    TName extends string,
    TBranches extends Record<string, ParallelBranchDefinition<TInput, TResults, unknown>>,
  >(
    name: TName,
    branches: TBranches,
    options: ParallelGroupOptions = {},
  ): Flow<TInput, TResults & { [K in TName]: ParallelBranchResults<TBranches> }> {
    if (this._steps.some((s) => s.name === name)) {
      throw new Error(`kompensa: duplicate step name "${String(name)}" in flow "${this.name}"`);
    }
    const branchNames = Object.keys(branches);
    if (branchNames.length === 0) {
      throw new Error(
        `kompensa: parallel group "${String(name)}" in flow "${this.name}" has no branches`,
      );
    }
    for (const bn of branchNames) {
      if (!bn || typeof bn !== 'string') {
        throw new Error(
          `kompensa: parallel group "${String(name)}" has an invalid branch name`,
        );
      }
    }

    // Sentinel definition so the executor never accidentally runs a parallel
    // group via the sequential code path. The real dispatch lives in the
    // executor's parallel branch (added in v0.3 executor work). If this stub
    // ever fires, it means the executor mis-routed — fail loudly.
    const stubDefinition: StepDefinition<unknown, Record<string, unknown>, unknown> = {
      run: () => {
        throw new Error(
          `kompensa: internal error — parallel group "${String(name)}" was routed through the sequential executor`,
        );
      },
    };

    this._steps.push({
      name,
      kind: 'parallel',
      definition: stubDefinition,
      branches: branches as unknown as RegisteredStep['branches'],
      parallelOptions: options,
    });

    return this as unknown as Flow<
      TInput,
      TResults & { [K in TName]: ParallelBranchResults<TBranches> }
    >;
  }

  /** Expose the registered step list for inspection (read-only copy). */
  get steps(): ReadonlyArray<{ name: string; kind: 'sequential' | 'parallel'; branches?: string[] }> {
    return this._steps.map((s) => ({
      name: s.name,
      kind: (s.kind ?? 'sequential') as 'sequential' | 'parallel',
      ...(s.branches ? { branches: Object.keys(s.branches) } : {}),
    }));
  }

  /**
   * Run the flow. Re-running with the same `idempotencyKey` returns the
   * previously-cached result (if succeeded) or resumes from the last
   * successful step (if the prior run was interrupted).
   */
  async execute(input: TInput, options: ExecuteOptions = {}): Promise<TResults> {
    if (this._steps.length === 0) {
      throw new Error(`kompensa: flow "${this.name}" has no steps`);
    }
    return executeFlow<TInput, TResults>({
      flowName: this.name,
      steps: this._steps,
      input,
      config: this.config,
      options,
    });
  }
}

/**
 * Create a new flow. Generic parameter defines the input shape; step results
 * are inferred from `.step()` calls.
 *
 * @example
 * const checkout = createFlow<{ orderId: string }>('checkout')
 *   .step('reserve', { run: async (c) => reserve(c.input.orderId), compensate: release })
 *   .step('charge',  { run: async (c) => charge(c.input.orderId),  compensate: refund  })
 *
 * await checkout.execute({ orderId: '42' }, { idempotencyKey: 'order-42' })
 */
export function createFlow<TInput = unknown>(
  name: string,
  config: FlowConfig = {},
): Flow<TInput, EmptyResults> {
  if (!name || typeof name !== 'string') {
    throw new Error('kompensa: flow name must be a non-empty string');
  }
  return new Flow<TInput, EmptyResults>(name, config);
}
