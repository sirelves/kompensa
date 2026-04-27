# Concepts

## The execution model

A flow is a typed, ordered list of steps. When you `execute(input)`, kompensa:

1. **Acquires a distributed lock** on `(flowName, idempotencyKey)` — other workers attempting the same key block or fail fast.
2. **Loads any prior state** from the storage adapter.
3. **Short-circuits** if the prior state is terminal:
   - `success` → returns the cached result
   - `compensated` / `failed` → re-throws the original `FlowError`
4. **Runs steps sequentially**, persisting state after every transition.
5. **On step failure**, runs `compensate` on each prior successful step in reverse order.
6. **Releases the lock**.

The whole lifecycle is a state machine. Every transition is saved to storage, so a crashed process can be resumed by calling `execute()` again with the same key.

## State machine

### Flow status

```
    ┌───────────┐
    │  pending  │   (briefly — before first save)
    └─────┬─────┘
          ▼
    ┌───────────┐         ┌───────────────┐
    │  running  │────────▶│ compensating  │
    └─────┬─────┘         └───────┬───────┘
          │                       ▼
          │               ┌───────────────┐
          │               │ compensated   │
          │               └───────────────┘
          ▼
    ┌───────────┐
    │  success  │
    └───────────┘
```

`failed` is used for crashes that couldn't be attributed to a specific step (e.g., abort before any step ran).

### Step status

- `pending` — never run
- `running` — currently in progress
- `success` — completed successfully
- `failed` — exhausted retries with a non-retryable error
- `compensating` / `compensated` — rolling back
- `skipped` — `skipIf` returned true

## Idempotency

`idempotencyKey` is the primary key of the execution. It identifies the work, not the input.

| Scenario | What kompensa does |
| --- | --- |
| Key never seen | Runs normally |
| Key succeeded previously | Returns cached `result` — skips every step |
| Key failed & compensated previously | Re-throws the original `FlowError` |
| Key in `running` status (crash) | Resumes from the first non-`success` step |

**Rules:**

- The key must be stable for equivalent work. A good key includes the business identifier (`order-123`, `payment-abc`). Never include a timestamp or UUID per call.
- The key is scoped to the flow name, so `order-123` in flow `checkout` and `order-123` in flow `refund` are independent.
- If you don't pass a key, kompensa generates one — but you lose idempotency across retries from the caller.

## Compensation (Saga pattern)

Each step may declare a `compensate` function — the semantic inverse of `run`. When a later step fails:

1. The failing step's state becomes `failed`.
2. kompensa walks backwards through the completed steps.
3. For each step with `compensate`, it calls it with the step's result.
4. The flow status becomes `compensated`.
5. A `FlowError` is thrown containing the original failure and any compensation errors.

**Compensations run in reverse order:**

```
steps:  reserve → charge → invoice
fail at invoice
     ↓
compensate: charge.compensate → reserve.compensate
```

**Compensation errors don't hide the root cause:**

```ts
try {
  await flow.execute(input);
} catch (err) {
  if (err instanceof FlowError) {
    err.failedStep;           // 'charge'
    err.originalError;        // Error: card declined
    err.compensationErrors;   // [{ step: 'reserve', error: ... }]
  }
}
```

**Compensations must be idempotent.** kompensa persists compensation status so crash-during-compensate can be resumed, but your logic should be safe to re-run (e.g., "refund if charge exists" rather than "refund blindly").

## Parallel step groups (fan-out / fan-in)

`.parallel(name, branches, options?)` runs multiple branches concurrently and merges their results into one named entry. Each branch accepts the same step definition shape (`run`, `compensate`, `retry`, `timeout`, `skipIf`).

```ts
createFlow<{ orderId: string }>('checkout')
  .parallel('externals', {
    pricing:  { run: (ctx) => api.pricing(ctx.input.orderId) },
    shipping: { run: (ctx) => api.shipping(ctx.input.orderId) },
    tax:      { run: (ctx) => api.tax(ctx.input.orderId), retry: { maxAttempts: 3 } },
  })
  .step('charge', {
    run: (ctx) => charge(ctx.results.externals.pricing.amount),
  });
```

**Execution semantics**

- Branches run via `Promise.allSettled` with a shared `AbortSignal` derived from the flow's signal.
- **Fail-fast** is on by default: when any branch rejects, surviving branches receive `signal.aborted` so they can cancel their work cooperatively.
- **`{ abortOnFailure: false }`** runs every branch to completion regardless of sibling failures. The flow still fails — this just gives you full per-branch observability.
- **`{ groupTimeout: ms }`** caps the entire group; per-branch `timeout` still applies independently.

**Compensation**

- Default: branches with a `compensate` run **in parallel** via `Promise.allSettled` (symmetric with execution).
- **`{ compensateSerially: true }`**: walks branches in **reverse-completion-order** by `endedAt`. Use when there is a causal dependency between branches (e.g., branch B reserved a resource the cleanup of branch A depends on).

**Crash recovery**

Each branch persists under `state.steps[i].branches[branchName]` as its own `StepState`. On resume, branches with `status === 'success'` are skipped — only `pending` / `running` / `failed` branches re-execute.

**Hooks**

Per-branch lifecycle events fire with dot-notation `stepName: 'group.branch'`:

```
onStepStart   stepName: 'externals.pricing'  attempt: 1
onStepStart   stepName: 'externals.shipping' attempt: 1
onStepStart   stepName: 'externals.tax'      attempt: 1
onStepEnd     stepName: 'externals.pricing'  status: 'success'
onStepEnd     stepName: 'externals.shipping' status: 'success'
onStepRetry   stepName: 'externals.tax'      attempt: 2
onStepEnd     stepName: 'externals.tax'      status: 'success'
```

This is intentionally compatible with OpenTelemetry-style span hierarchies (parent group span + child branch spans).

## Retry

```ts
retry: {
  maxAttempts: 3,                 // includes the first attempt
  backoff: 'exponential',         // 'fixed' | 'linear' | 'exponential'
  initialDelayMs: 100,            // delay before second attempt
  maxDelayMs: 30_000,             // cap
  multiplier: 2,                  // growth factor (exponential only)
  jitter: true,                   // boolean OR fraction 0..1
  shouldRetry: (err, attempt) => err.code !== 'E_NOT_ALLOWED',
}
```

Delay formulas (before jitter):

| Backoff | Formula |
| --- | --- |
| `fixed` | `initialDelayMs` |
| `linear` | `initialDelayMs × attempt` |
| `exponential` | `initialDelayMs × multiplier^(attempt-1)` |

**Jitter** randomizes the delay to prevent thundering-herd on shared resources.

- `jitter: true` → full jitter: random in `[0, delay]`
- `jitter: 0.1` → 10% window: random in `[0.9×delay, delay]`
- `jitter: false` → deterministic

**Error classes:**

- `PermanentError` — never retried. Use for validation, 4xx, business-rule violations.
- `TransientError` — explicitly retryable. Use for rate-limiting, timeouts, network blips.
- Generic `Error` — retryable by default unless `shouldRetry` returns false.

**During retry delays, AbortSignal is honored.** An abort mid-delay rejects with `FlowAbortedError` rather than sleeping the full window.

## Timeouts

Per-step timeout:

```ts
.step('http', {
  run: async (ctx) => fetch(url, { signal: ctx.signal }),
  timeout: 5_000,
})
```

When the timeout fires, the step's promise is rejected with `StepTimeoutError`. That error is retryable by default — combine with `retry: { maxAttempts: 3 }` for "try up to 3 times, 5 seconds each."

**Pass `ctx.signal` to your network calls.** The timeout causes the promise to reject, but the underlying work (HTTP request, DB query) keeps running unless you forward the signal.

## Distributed locks

When the storage adapter supports `acquireLock`, every `execute()` call:

1. Acquires an exclusive lock on `(flowName, flowId)`.
2. Loads / writes state.
3. Runs steps.
4. Releases the lock.

**Why:** without a lock, two workers starting `execute('checkout', { idempotencyKey: 'order-1' })` simultaneously would both load state (null), both start executing, both charge the customer. The lock serializes concurrent callers on the same key.

**Configuration:**

```ts
createFlow('checkout', {
  storage,
  lockTtlMs: 5 * 60_000,   // default: 5 minutes
  lockWaitMs: 30_000,      // default: 30 seconds
})
```

- `lockTtlMs` — lock expiration. Must exceed the max expected execution time. Protects against deadlocks when a worker crashes.
- `lockWaitMs` — how long to wait for the lock before throwing `LockAcquisitionError`. Use `0` to fail fast (the other worker is still running — don't queue behind it).

**Adapter differences:**

| Adapter | Lock mechanism | TTL behavior |
| --- | --- | --- |
| `MemoryStorage` | In-process Map + queue | setTimeout-based |
| `PostgresStorage` | `pg_advisory_lock(int, int)` on a dedicated connection | Released on connection close (no server-side TTL) |
| `RedisStorage` | `SET NX PX` with Lua-safe release | Redis expiry, exact TTL |

For Postgres, `ttlMs` is advisory-only — the lock auto-releases when the holding connection closes, which happens on crash. For Redis, `ttlMs` is enforced by the server.

## Hooks

Every lifecycle event is emitted as an async hook:

```ts
createFlow('checkout', {
  hooks: {
    onFlowStart:  (e) => tracer.startSpan(e.flowName, e.flowId),
    onStepStart:  (e) => metrics.inc('step.start', { step: e.stepName }),
    onStepRetry:  (e) => logger.warn({ retry: e.stepName, attempt: e.attempt }),
    onStepEnd:    (e) => metrics.timing('step.duration', e.durationMs),
    onCompensate: (e) => logger.error({ compensating: e.stepName }),
    onFlowEnd:    (e) => tracer.endSpan(e.flowId, e.status),
  },
});
```

Hooks are sequential (one at a time) and awaited. Hook errors are logged at `warn` level and **never** interrupt the flow — observability cannot break execution.

## Cancellation

An `AbortSignal` cancels execution. It's respected:

- Between steps (at the start of each iteration)
- During retry delays
- Inside your step, via `ctx.signal` if you pass it to your network calls

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000);

try {
  await flow.execute(input, { signal: controller.signal });
} catch (err) {
  // FlowError wrapping FlowAbortedError
}
```

**Abort triggers compensation.** Prior successful steps are rolled back just like any other failure.
