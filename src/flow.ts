import type {
  ExecuteOptions,
  FlowConfig,
  StepDefinition,
} from './types.js';
import { executeFlow, type RegisteredStep } from './executor.js';

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
      throw new Error(`sagaflow: duplicate step name "${String(name)}" in flow "${this.name}"`);
    }
    this._steps.push({
      name: name,
      definition: definition as unknown as RegisteredStep['definition'],
    });
    return this as unknown as Flow<TInput, TResults & { [K in TName]: TResult }>;
  }

  /** Expose the registered step list for inspection (read-only copy). */
  get steps(): ReadonlyArray<{ name: string }> {
    return this._steps.map((s) => ({ name: s.name }));
  }

  /**
   * Run the flow. Re-running with the same `idempotencyKey` returns the
   * previously-cached result (if succeeded) or resumes from the last
   * successful step (if the prior run was interrupted).
   */
  async execute(input: TInput, options: ExecuteOptions = {}): Promise<TResults> {
    if (this._steps.length === 0) {
      throw new Error(`sagaflow: flow "${this.name}" has no steps`);
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
    throw new Error('sagaflow: flow name must be a non-empty string');
  }
  return new Flow<TInput, EmptyResults>(name, config);
}
