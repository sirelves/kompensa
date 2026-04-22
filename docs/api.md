# API reference

Every public export from `kompensa`. For conceptual docs, see [concepts.md](./concepts.md).

## Entry points

| Import path | Purpose |
| --- | --- |
| `kompensa` | Core — `createFlow`, errors, `MemoryStorage` |
| `kompensa/storage/memory` | `MemoryStorage` (also re-exported from core) |
| `kompensa/storage/postgres` | `PostgresStorage` + `PgPoolLike` type (peer dep: `pg`) |
| `kompensa/storage/redis` | `RedisStorage` + `RedisLike` type (peer dep: `ioredis`) |

## `createFlow<TInput>(name, config?): Flow<TInput, {}>`

Create a new flow builder.

```ts
createFlow<{ orderId: string }>('checkout', {
  storage: myStorage,
  logger: myLogger,
  hooks: { /* ... */ },
  defaultRetry: { maxAttempts: 3 },
  defaultTimeout: 10_000,
  lockTtlMs: 300_000,
  lockWaitMs: 30_000,
});
```

## `Flow<TInput, TResults>`

### `.step(name, definition): Flow<TInput, TResults & Record<name, TResult>>`

Append a step. Duplicates throw at runtime. Returns a new Flow whose result type includes this step's return value.

### `.execute(input, options?): Promise<TResults>`

Run the flow. Throws:

- `FlowError` — a step failed (possibly compensated)
- `LockAcquisitionError` — lock held by another worker
- Your own unwrapped errors from unexpected paths

### `.steps: ReadonlyArray<{ name: string }>`

Read-only list of step names, useful for logging and inspection.

## `StepDefinition<TInput, TResults, TResult>`

```ts
{
  run: (ctx: StepContext<TInput, TResults>) => TResult | Promise<TResult>;
  compensate?: (ctx: StepContext<TInput, TResults>, result: TResult) => void | Promise<void>;
  retry?: RetryPolicy;
  timeout?: number;
  skipIf?: (ctx: StepContext<TInput, TResults>) => boolean | Promise<boolean>;
}
```

## `StepContext<TInput, TResults>`

```ts
{
  input: TInput;
  results: TResults;
  metadata: Record<string, unknown>;
  attempt: number;          // 1-based; 0 during skipIf
  signal: AbortSignal;
  flowId: string;
  flowName: string;
  stepName: string;
  logger: Logger;
}
```

## `RetryPolicy`

```ts
{
  maxAttempts?: number;        // default 1
  backoff?: 'fixed' | 'linear' | 'exponential';  // default 'exponential'
  initialDelayMs?: number;     // default 100
  maxDelayMs?: number;         // default 30_000
  multiplier?: number;         // default 2 (exponential)
  jitter?: boolean | number;   // default true
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}
```

## `ExecuteOptions`

```ts
{
  idempotencyKey?: string;   // primary key of the execution
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  timeout?: number;           // default for all steps in this execution
}
```

## `FlowConfig`

```ts
{
  storage?: StorageAdapter;
  logger?: Logger;
  hooks?: FlowHooks;
  defaultRetry?: RetryPolicy;
  defaultTimeout?: number;
  lockTtlMs?: number;          // default 300_000 (5 min)
  lockWaitMs?: number;         // default 30_000 (30 s)
}
```

## Errors

### `FlowError`

Thrown by `execute()` when a step fails.

```ts
class FlowError extends Error {
  readonly flowId: string;
  readonly flowName: string;
  readonly failedStep: string;
  readonly originalError: unknown;
  readonly compensationErrors: Array<{ step: string; error: unknown }>;
}
```

### `LockAcquisitionError`

Thrown by `execute()` when the storage adapter's lock could not be acquired within `lockWaitMs`.

### `PermanentError`

Throw to dead-stop retries. Never retried regardless of `RetryPolicy.maxAttempts`.

### `TransientError`

Throw to explicitly mark an error as retryable. Always retried (subject to `maxAttempts`).

### `StepTimeoutError`

Thrown automatically when a step exceeds its `timeout`. Retryable by default.

### `FlowAbortedError`

Thrown when execution is cancelled via `AbortSignal`. Triggers compensation.

### `isPermanent(err): boolean`, `isTransient(err): boolean`

Runtime type guards.

### `serializeError(err): SerializedError`

Convert an error into a persistable plain object.

## Storage

### `StorageAdapter`

```ts
interface StorageAdapter {
  load(flowName: string, flowId: string): Promise<FlowState | null>;
  save(state: FlowState): Promise<void>;
  delete?(flowName: string, flowId: string): Promise<void>;
  acquireLock?(
    flowName: string,
    flowId: string,
    options: AcquireLockOptions,
  ): Promise<Lock>;
}
```

### `AcquireLockOptions`

```ts
{
  ttlMs: number;
  timeoutMs: number;   // 0 to fail fast
}
```

### `Lock`

```ts
{
  release(): Promise<void>;
  refresh?(): Promise<void>;
}
```

### `MemoryStorage`

In-process adapter. FIFO waiters, setTimeout TTL, deep-cloned snapshots.

```ts
class MemoryStorage implements StorageAdapter {
  load, save, delete, acquireLock;
  snapshot(): FlowState[];
  clear(): void;
  readonly size: number;
}
```

### `PostgresStorage`

```ts
class PostgresStorage implements StorageAdapter {
  constructor(opts: {
    pool: PgPoolLike;        // pg.Pool structural type
    tableName?: string;      // default 'kompensa_states'
    lockNamespace?: string;  // default 'kompensa'
    lockPollMs?: number;     // default 50
  });
  load, save, delete, acquireLock;
  ensureSchema(): Promise<void>;   // one-time table creation
}
```

### `RedisStorage`

```ts
class RedisStorage implements StorageAdapter {
  constructor(opts: {
    client: RedisLike;       // ioredis structural type
    keyPrefix?: string;      // default 'kompensa'
    lockPollMs?: number;     // default 50
  });
  load, save, delete, acquireLock;
}
```

## Observability

### `Logger`

```ts
interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child?(meta: Record<string, unknown>): Logger;
}
```

### Provided loggers

- `silentLogger` — discards all output (default)
- `consoleLogger` — prints to console with `[kompensa]` prefix

### `FlowHooks`

```ts
interface FlowHooks {
  onFlowStart?(event: FlowStartEvent): void | Promise<void>;
  onFlowEnd?(event: FlowEndEvent): void | Promise<void>;
  onStepStart?(event: StepStartEvent): void | Promise<void>;
  onStepRetry?(event: StepRetryEvent): void | Promise<void>;
  onStepEnd?(event: StepEndEvent): void | Promise<void>;
  onCompensate?(event: CompensateEvent): void | Promise<void>;
}
```

All events share `{ flowName, flowId, metadata }`. Additional per-event fields:

- `FlowStartEvent` — `input`, `resumed`
- `FlowEndEvent` — `status`, `results?`, `error?`, `durationMs`
- `StepStartEvent` — `stepName`, `stepIndex`, `attempt`
- `StepRetryEvent` — `stepName`, `stepIndex`, `attempt`, `error`, `nextDelayMs`
- `StepEndEvent` — `stepName`, `stepIndex`, `status`, `attempts`, `durationMs`, `result?`, `error?`
- `CompensateEvent` — `stepName`, `stepIndex`, `status`, `error?`

## State

### `FlowState`, `StepState`, `FlowStatus`, `StepStatus`, `SerializedError`

Exposed for adapter authors who need to construct / inspect state rows. See [types.ts](../src/types.ts) for exact shape.

## Retry internals

Exposed for advanced use and adapter authors:

- `computeDelay(policy?, attempt): number`
- `shouldRetryError(policy?, err, attempt): boolean`
- `getMaxAttempts(policy?): number`
