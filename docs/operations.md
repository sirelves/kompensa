# Operations

## Production checklist

Before shipping sagaflow to production, verify each of these:

### Storage

- [ ] Using a durable adapter (`PostgresStorage` or `RedisStorage`), **not** `MemoryStorage`
- [ ] Schema migration applied (`ensureSchema()` or equivalent) before first `execute()`
- [ ] Connection pool sized for `expected_concurrent_flows × 2` (each flow holds 1 lock connection + transient connections)
- [ ] Backup / recovery strategy for the state table (same as any operational database)

### Idempotency

- [ ] Every `execute()` call passes an `idempotencyKey` that's stable across retries
- [ ] Key includes the business identifier, **never** `Date.now()` or a fresh UUID per call
- [ ] For HTTP endpoints: accepting `Idempotency-Key` header and passing it through

### Compensation

- [ ] Every destructive step (state change, external charge, email send) has a `compensate`
- [ ] Compensations are idempotent — safe to re-run if the flow is retried mid-rollback
- [ ] Compensation errors are monitored — they indicate partial failure that needs human review

### Locking

- [ ] `lockTtlMs` configured for the longest expected execution time plus safety margin (default 5 minutes)
- [ ] `lockWaitMs` set intentionally (`0` for HTTP, longer for background workers)
- [ ] `LockAcquisitionError` handled explicitly — return 409 or let the queue retry

### Retry

- [ ] `PermanentError` thrown for 4xx / business validations
- [ ] `TransientError` thrown for 429 / 5xx / network blips
- [ ] `maxAttempts` bounded — no infinite retry loops
- [ ] `timeout` configured on steps that call external services
- [ ] `jitter` enabled — reduces thundering herd on shared resources

### Observability

- [ ] Hooks wired to your logging, metrics, and tracing
- [ ] `FlowError.failedStep` logged on every failure
- [ ] `compensationErrors` logged at error level — these are the "worst case" signal

## Metrics to track

Wire these to your metrics system via hooks:

```ts
hooks: {
  onFlowStart:  (e) => metrics.inc('flow.start',    { flow: e.flowName, resumed: e.resumed }),
  onFlowEnd:    (e) => metrics.timing('flow.duration', e.durationMs, { status: e.status, flow: e.flowName }),
  onStepEnd:    (e) => metrics.timing('step.duration', e.durationMs, { step: e.stepName, status: e.status }),
  onStepRetry:  (e) => metrics.inc('step.retry',    { step: e.stepName, attempt: e.attempt }),
  onCompensate: (e) => metrics.inc('flow.compensate', { step: e.stepName, status: e.status }),
}
```

Key dashboards:

- **Success rate** = `flow.end.status='success'` / `flow.start`
- **Compensation rate** = `flow.compensate{status='compensated'}` / `flow.start` — spikes indicate downstream outages
- **Retry pressure** = `step.retry` / `step.end` — high means an upstream is unstable
- **Lock contention** = count of `LockAcquisitionError` — high means your idempotency keys aren't granular enough

## Troubleshooting

### `LockAcquisitionError` under normal load

Two workers are racing on the same key. Either:

1. The client is retrying too aggressively (before the original request completes). Increase client-side backoff.
2. Your idempotency keys collide — different requests map to the same key. Make keys more granular.
3. A prior worker crashed before releasing (Postgres advisory locks release on disconnect; Redis locks expire via TTL; MemoryStorage locks expire via TTL). Verify `lockTtlMs` is set.

### Flow hangs forever

- `lockTtlMs` too high and a prior worker died without releasing (Postgres auto-releases on disconnect, Redis via TTL — only MemoryStorage needs explicit TTL)
- A step has `timeout` unset and its underlying call never resolves. Add `timeout` + pass `ctx.signal` to the underlying call.
- Retry policy with huge `maxDelayMs` and many attempts. Bound `maxAttempts`.

### State table growing unbounded

sagaflow never deletes its own state unless you call `storage.delete()`. Add a janitor job:

```sql
DELETE FROM sagaflow_states
WHERE status = 'success'
  AND updated_at < NOW() - INTERVAL '30 days';
```

How long to retain terminal states is a product decision — usually you want `success` rows around for audit / customer support, and `compensated` rows kept longer for post-mortems.

### Compensation threw an error

`FlowError.compensationErrors` lists every compensation that failed. These indicate **partial failure** — the system is in an inconsistent state and typically needs human review:

```ts
flow.execute(input).catch((err) => {
  if (err instanceof FlowError && err.compensationErrors.length > 0) {
    alerting.pageOncall('compensation failure', {
      flowId: err.flowId,
      failedStep: err.failedStep,
      compensations: err.compensationErrors,
    });
  }
});
```

### Resume from crash doesn't work

If `execute()` doesn't resume from the last successful step:

- Verify the storage adapter was used by both the original and retry calls
- Verify the `idempotencyKey` is identical (including case / whitespace)
- Check the state row in your database — if `status='compensated'`, the flow already failed and won't re-run

To force a re-run, delete the state row (or call `storage.delete(flowName, flowId)`).

## Upgrading

sagaflow follows semver once it hits v1. Pre-1.0, minor bumps may include breaking API changes — pin exact versions until you've validated. Check [CHANGELOG.md](../CHANGELOG.md) before upgrading.
