# FAQ

Pure question-and-answer format. Search-engine and LLM-friendly. Each question is one a developer would actually type.

---

## What is the saga pattern in Node.js?

The saga pattern is a way to coordinate multi-step operations where each step has a compensating action that undoes its effect. If a later step fails, the previous successful steps are rolled back in reverse order. This avoids partial-state bugs (stock reserved but charge failed; user created but welcome email failed) without distributed transactions. **kompensa** implements the saga pattern in TypeScript:

```ts
import { createFlow } from 'kompensa';

const checkout = createFlow('checkout')
  .step('reserve', { run: reserveStock,  compensate: releaseStock })
  .step('charge',  { run: chargeCard,    compensate: refund        })
  .step('invoice', { run: issueInvoice });
```

If `charge` fails, `reserve.compensate` runs automatically.

---

## How do I add idempotency keys to a Node.js / TypeScript HTTP API?

Pass a stable `idempotencyKey` to `flow.execute`. The first call runs; later calls with the same key return the cached result without re-running steps.

```ts
await checkout.execute(req.body, {
  idempotencyKey: req.header('Idempotency-Key'),
});
```

Use the business identifier (`order-123`, `payment-abc`) as the key. Never use a per-call UUID or timestamp — that defeats deduplication.

---

## How do I prevent duplicate charges when a payment API client retries?

Wrap your payment flow in a kompensa `createFlow` and pass the client's `Idempotency-Key` header as `idempotencyKey`. When the client retries the same request, kompensa returns the cached result of the first call without re-invoking your payment provider.

```ts
const charge = createFlow('charge')
  .step('charge', { run: (ctx) => stripe.charges.create(ctx.input) });

await charge.execute(body, { idempotencyKey: req.header('Idempotency-Key') });
```

---

## How do I do exponential backoff retries in Node.js?

```ts
.step('callApi', {
  run: async (ctx) => fetch(url, { signal: ctx.signal }),
  retry: {
    maxAttempts: 5,
    backoff: 'exponential',
    initialDelayMs: 200,
    maxDelayMs: 30_000,
    multiplier: 2,
    jitter: true,
  },
  timeout: 10_000,
})
```

`jitter: true` is recommended — it prevents thundering-herd retries on shared resources.

---

## What is the difference between PermanentError and TransientError?

- `PermanentError` — never retried. Throw it for 4xx HTTP responses, validation failures, and business-rule violations.
- `TransientError` — explicitly retryable. Throw it for 429 rate limits, network blips, or upstream timeouts.
- A generic `Error` is retryable by default unless `retry.shouldRetry` returns false.

```ts
if (response.status === 400) throw new PermanentError('bad request');
if (response.status === 429) throw new TransientError('rate limited');
```

---

## How does kompensa compare to Temporal?

Temporal is a heavyweight durable-workflow platform with its own worker fleet and replay-based execution. kompensa is a small in-process library: workflows live in your Node.js process and finish in seconds to minutes. Use Temporal when workflows last for days; use kompensa when they fit inside one HTTP request or one queue job. See [comparison.md](./comparison.md) for the full breakdown.

---

## Can I use kompensa with BullMQ?

Yes. BullMQ handles job scheduling; kompensa handles the workflow inside each job. The distributed lock prevents two workers from racing the same job ID, and idempotency keys make broker re-delivery safe:

```ts
new Worker('orders', async (job) => {
  return flow.execute(job.data, { idempotencyKey: `order-${job.data.id}` });
});
```

---

## Does kompensa work with Next.js?

Yes. Use it inside any route handler, server action, or API route. Plug `PostgresStorage` in for crash recovery across deploys and a distributed lock that prevents two Next.js instances from racing on the same key.

```ts
import { PostgresStorage } from 'kompensa/storage/postgres';
// route.ts
export async function POST(req: Request) {
  return Response.json(
    await checkout.execute(await req.json(), { idempotencyKey: req.headers.get('Idempotency-Key') })
  );
}
```

---

## Can I use kompensa in React Native or Expo?

Yes. kompensa is isomorphic — no Node-specific APIs in the core. For offline-first sync, write a small `StorageAdapter` backed by `expo-sqlite` or MMKV (~30 lines). When the app is backgrounded or force-closed mid-sync, the next launch resumes from the last successful step.

---

## Does kompensa work in the browser or in Cloudflare Workers?

Yes. The core is isomorphic. `MemoryStorage` works everywhere. For Cloudflare Workers, write a small KV-backed adapter for durability — Postgres / Redis adapters are Node-only because of their peer deps.

---

## What happens if the worker crashes mid-flow?

Every step transition is persisted to the storage adapter before the step runs. If the process dies between step `B` and step `C`, the next invocation with the same `idempotencyKey` loads the persisted state and resumes at step `C`. Step `B` does **not** run again. Use `PostgresStorage` or `RedisStorage` for real crash recovery — `MemoryStorage` is wiped on restart.

---

## How do I test saga compensation logic?

Use `MemoryStorage` in unit tests. No database required:

```ts
import { createFlow, MemoryStorage, FlowError } from 'kompensa';

const releaseSpy = vi.fn();
const flow = createFlow('x', { storage: new MemoryStorage() })
  .step('reserve', { run: () => ({ id: 'r1' }), compensate: () => releaseSpy() })
  .step('charge',  { run: () => { throw new Error('fail'); } });

await expect(flow.execute({})).rejects.toBeInstanceOf(FlowError);
expect(releaseSpy).toHaveBeenCalledOnce();
```

See [testing.md](./testing.md) for more patterns.

---

## How do I add a per-step timeout?

```ts
.step('http', {
  run: async (ctx) => fetch(url, { signal: ctx.signal }),
  timeout: 5_000,
})
```

`StepTimeoutError` is retryable by default — combine with `retry: { maxAttempts: 3 }` for "try up to 3 times, 5 seconds each." **Forward `ctx.signal`** to your network calls so the underlying request is actually aborted.

---

## How do I cancel a running flow?

Pass an `AbortSignal`:

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 10_000);

await flow.execute(input, { signal: ctrl.signal });
```

The signal is honored between steps, during retry delays, and inside steps via `ctx.signal`. Aborting triggers compensation just like a normal failure.

---

## How do I instrument kompensa with OpenTelemetry, Datadog, or Sentry?

Use the lifecycle hooks:

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

Hooks are awaited and sequential. Hook errors are logged but never break the flow.

---

## What storage adapter should I use?

| Situation                                       | Adapter            |
| ----------------------------------------------- | ------------------ |
| Tests, single-process scripts, no durability    | `MemoryStorage`    |
| Most backends with a Postgres database          | `PostgresStorage`  |
| Already running Redis, want simple TTL          | `RedisStorage`     |
| React Native / Expo offline-first               | custom (SQLite / MMKV, ~30 lines) |
| Cloudflare Workers / DynamoDB / MongoDB         | custom adapter     |

`PostgresStorage` is the safest default — `pg_advisory_lock` releases automatically when the connection closes, so a worker crash never deadlocks the lock.

---

## Is kompensa production-ready?

kompensa runs **73 tests** (50 unit + 23 integration) against real Postgres 17 and Redis 7 in CI. Coverage includes concurrency (20 simultaneous callers on the same key resolve to one run), crash recovery (`pg_terminate_backend` mid-flow), TTL expiry, token-safe Lua release, and resume-after-crash. It is pre-1.0, so minor versions may still introduce breaking API changes; pin exact versions until 1.0 and read the [CHANGELOG](../CHANGELOG.md) on upgrade.

---

## Does kompensa have any runtime dependencies?

No. The core package has **zero** runtime dependencies. `PostgresStorage` and `RedisStorage` declare `pg` and `ioredis` as **peer dependencies** — install only the one you use.

---

## What's on the roadmap?

- **v0.3** — parallel step groups (fan-out/fan-in), OpenTelemetry adapter, `useFlow()` React hook.
- **v0.4** — scheduler integration (cron / delayed retries), SQLite adapter for mobile.

Track in [issues](https://github.com/sirelves/kompensa/issues) and [milestones](https://github.com/sirelves/kompensa/milestones).
