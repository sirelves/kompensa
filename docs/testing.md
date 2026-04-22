# Testing your flows

## Unit testing with `MemoryStorage`

For tests of your business logic, skip the database entirely:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createFlow, MemoryStorage, FlowError } from 'flowguard';

describe('checkout flow', () => {
  it('compensates reserve when charge fails', async () => {
    const release = vi.fn();
    const refund = vi.fn();

    const flow = createFlow<{ orderId: string }>('checkout', {
      storage: new MemoryStorage(),
    })
      .step('reserve', {
        run: () => ({ id: 'r1' }),
        compensate: async (_c, r) => release(r.id),
      })
      .step('charge', {
        run: () => {
          throw new Error('card declined');
        },
        compensate: async (_c, c) => refund(c.id),
      });

    await expect(flow.execute({ orderId: '1' })).rejects.toBeInstanceOf(FlowError);
    expect(release).toHaveBeenCalledWith('r1');
    expect(refund).not.toHaveBeenCalled(); // charge never succeeded
  });
});
```

## Asserting on hooks

Hooks are a clean way to assert on the ordering of events:

```ts
it('fires lifecycle in correct order', async () => {
  const events: string[] = [];
  const flow = createFlow('x', {
    hooks: {
      onFlowStart:  () => { events.push('flow:start'); },
      onStepStart:  (e) => { events.push(`step:start:${e.stepName}`); },
      onStepEnd:    (e) => { events.push(`step:end:${e.stepName}`); },
      onFlowEnd:    () => { events.push('flow:end'); },
    },
  })
    .step('a', { run: () => 'A' })
    .step('b', { run: () => 'B' });

  await flow.execute({});
  expect(events).toEqual([
    'flow:start',
    'step:start:a', 'step:end:a',
    'step:start:b', 'step:end:b',
    'flow:end',
  ]);
});
```

## Testing idempotency

Shared storage + same key + double execute:

```ts
it('is idempotent on retry', async () => {
  const storage = new MemoryStorage();
  const sideEffect = vi.fn();

  const flow = createFlow('x', { storage }).step('once', {
    run: () => { sideEffect(); return 'done'; },
  });

  await flow.execute({}, { idempotencyKey: 'k' });
  await flow.execute({}, { idempotencyKey: 'k' });

  expect(sideEffect).toHaveBeenCalledOnce();
});
```

## Integration testing with real adapters

Spin up Postgres or Redis via Docker and run tests that exercise the full adapter:

```bash
# Start services (port 5434 for postgres, 6381 for redis — avoids conflicts)
npm run test:services:up

# Run integration tests
npm run test:integration

# Tear down
npm run test:services:down
```

The integration tests in `test/integration/` are a good template for your own adapter tests. They cover:

- State save/load roundtrip
- Idempotent replay (cache hit)
- Compensated state persistence
- Concurrent execution on the same key (distributed lock proof)
- Concurrent execution on different keys (parallelism proof)
- Wait timeout and fail-fast behavior
- Lock release on success, failure, and crash
- Crash simulation (terminate backend, verify lock auto-releases)
- Resume from the first incomplete step

## Skipping hooks in tests

Sometimes you want to test retry logic without sleeping:

```ts
const flow = createFlow('x').step('flaky', {
  run: () => { /* ... */ },
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1,   // microseconds — test runs fast
    jitter: false,        // deterministic — no flaky tests
  },
});
```

Set `initialDelayMs: 1` and `jitter: false` to make retry tests deterministic and fast.

## Fake timers

If you're testing long-running flows, vitest fake timers work with flowguard's `setTimeout`-based delays:

```ts
it('respects exponential backoff', async () => {
  vi.useFakeTimers();
  // ... advance time with vi.advanceTimersByTimeAsync ...
  vi.useRealTimers();
});
```

## Abort signal

```ts
it('aborts cleanly mid-flight', async () => {
  const controller = new AbortController();
  const flow = createFlow('x').step('slow', {
    run: () => new Promise((r) => setTimeout(r, 5000)),
  });

  setTimeout(() => controller.abort(), 10);
  await expect(flow.execute({}, { signal: controller.signal })).rejects.toThrow();
});
```
