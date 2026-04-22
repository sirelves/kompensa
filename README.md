<div align="center">

# kompensa

**Resilient workflow orchestration for Node, browser and React Native.**
Sagas · idempotency · retry with backoff · compensation · timeouts · pluggable storage.
Zero runtime dependencies.

[![npm version](https://img.shields.io/npm/v/kompensa?color=cb3837&logo=npm)](https://www.npmjs.com/package/kompensa)
[![npm downloads/month](https://img.shields.io/npm/dm/kompensa?color=cb3837&logo=npm&label=downloads%2Fmonth)](https://www.npmjs.com/package/kompensa)
[![npm downloads/week](https://img.shields.io/npm/dw/kompensa?color=cb3837&logo=npm&label=downloads%2Fweek)](https://www.npmjs.com/package/kompensa)
[![bundle size](https://img.shields.io/bundlephobia/minzip/kompensa?label=minzipped)](https://bundlephobia.com/package/kompensa)
[![types](https://img.shields.io/npm/types/kompensa)](https://www.npmjs.com/package/kompensa)
[![node](https://img.shields.io/node/v/kompensa)](https://www.npmjs.com/package/kompensa)
[![license](https://img.shields.io/npm/l/kompensa?color=blue)](./LICENSE)
[![CI](https://github.com/sirelves/kompensa/actions/workflows/ci.yml/badge.svg)](https://github.com/sirelves/kompensa/actions/workflows/ci.yml)

[📚 Docs](./docs) · [🚀 Getting started](./docs/getting-started.md) · [🧩 Recipes](./docs/recipes) · [📈 Download trends](https://npm-stat.com/charts.html?package=kompensa) · [📦 npm](https://www.npmjs.com/package/kompensa) · [🐙 GitHub](https://github.com/sirelves/kompensa)

<a href="https://npm-stat.com/charts.html?package=kompensa">
  <img src="https://nodei.co/npm-dl.png?height=3&months=3" alt="downloads chart" />
</a>

</div>

---

## 30 seconds

```bash
npm install kompensa
```

```ts
import { createFlow } from 'kompensa';

const checkout = createFlow<{ orderId: string }>('checkout')
  .step('reserve', {
    run: async (ctx) => reserveStock(ctx.input.orderId),
    compensate: async (_ctx, r) => releaseStock(r.id),
  })
  .step('charge', {
    run: async (ctx) => chargeCard(ctx.input.orderId, ctx.results.reserve.total),
    compensate: async (_ctx, c) => refund(c.id),
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 200 },
    timeout: 5_000,
  })
  .step('invoice', {
    run: async (ctx) => issueInvoice(ctx.results.charge.id),
  });

await checkout.execute(
  { orderId: '42' },
  { idempotencyKey: 'order-42' },
);
```

If `charge` fails → `reserve` is **compensated automatically**.
Re-running with the same `idempotencyKey` → returns the cached result.
Process crashed mid-flow? → **resumes from the last successful step**.

---

## Why you want this

Every non-trivial system hits these four bugs in production. Each team reinvents the wheel — badly:

| Problem                           | Without kompensa                           | With kompensa                        |
| --------------------------------- | ------------------------------------------- | ------------------------------------- |
| **Duplicate charges**             | Client retries, customer billed twice       | `idempotencyKey` → result cached      |
| **Partial failure leaks**         | Stock locked forever after payment crashed  | Saga auto-compensates on downstream failure |
| **Dumb retry loops**              | Hammers 3rd-party API on 4xx forever        | `PermanentError` vs `TransientError`, backoff + jitter |
| **Chain of hung requests**        | Whole request blocked by one stuck call     | Per-step timeout with `StepTimeoutError`     |
| **Crash = lost work**             | Retry the whole flow from scratch           | Resume from last completed step (w/ persistent storage) |

Not a framework, not a platform — **a small, typed library** that turns `try/catch` soup into a saga with structured failure handling.

---

## Feature matrix

| Feature                                         | Status |
| ----------------------------------------------- | :----: |
| Fluent builder with typed result accumulation   | ✅     |
| Idempotency via execution key                   | ✅     |
| Retry — fixed / linear / exponential + jitter   | ✅     |
| Saga compensation (reverse order on failure)    | ✅     |
| Per-step timeout                                | ✅     |
| AbortSignal cancellation                        | ✅     |
| Lifecycle hooks (start/retry/end/compensate)    | ✅     |
| Persistent state (resume after crash)           | ✅     |
| `MemoryStorage` adapter                         | ✅     |
| `PostgresStorage` with advisory lock            | ✅ v0.2 |
| `RedisStorage` with Redlock-style lock          | ✅ v0.2 |
| Distributed lock (multi-worker safety)          | ✅ v0.2 |
| Parallel step groups (fan-out/fan-in)           | 🗓️ v0.3 |
| OpenTelemetry adapter                           | 🗓️ v0.3 |
| `useFlow()` React hook                          | 🗓️ v0.3 |

---

## Install

```bash
npm  install kompensa
pnpm add     kompensa
yarn add     kompensa
bun  add     kompensa
```

Requires Node 18+. Works in modern browsers and React Native (Hermes).

---

## Core concepts

### Steps

A step has a `run` and an optional `compensate`. Steps see the input and every previous step's result, typed:

```ts
createFlow<{ email: string }>('signup')
  .step('createUser', {
    run: async (ctx) => db.users.create({ email: ctx.input.email }),
    compensate: async (_ctx, user) => db.users.delete(user.id),
  })
  .step('sendEmail', {
    run: async (ctx) => mailer.send(ctx.results.createUser.id, 'welcome'),
    //                                      ^^^^^^^^^^ statically typed
  });
```

### Retry policy

```ts
{
  maxAttempts: 3,
  backoff: 'exponential',   // 'fixed' | 'linear' | 'exponential'
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: true,             // true | false | 0..1 fraction
  shouldRetry: (err, n) => err.code !== 'E_FORBIDDEN',
}
```

Throw `PermanentError` to dead-stop retries; `TransientError` is always eligible.

### Idempotency and resume

| Prior state     | Behavior                                                  |
| --------------- | --------------------------------------------------------- |
| `success`       | Returns cached result, skips all steps                    |
| `compensated`   | Re-throws the original `FlowError`                        |
| `running` (crash)| Resumes from the first non-`success` step                |
| _(none)_        | Normal execution                                          |

### Saga compensation

On any step failure, previous successful steps run their `compensate` in **reverse order**. Compensation errors are collected and attached to the thrown `FlowError` — never mask the original cause:

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

### Cancellation

Pass an `AbortSignal`. Respected between steps, during retry delays, and visible to step `run()` via `ctx.signal`:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

await flow.execute(input, { signal: controller.signal });
```

---

## Real-world recipes

### Backend — idempotent HTTP endpoint

```ts
app.post('/checkout', async (req, res) => {
  try {
    const result = await checkoutFlow.execute(req.body, {
      idempotencyKey: req.headers['idempotency-key'] as string,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof FlowError) {
      // stock released + card refunded already happened
      return res.status(409).json({ failedAt: err.failedStep, error: err.message });
    }
    throw err;
  }
});
```

### Mobile — offline order sync (React Native)

```tsx
const syncOrder = createFlow<{ orderId: string }>('sync-order')
  .step('upload',     { run: (c) => api.post('/orders', c.input), retry: { maxAttempts: 5 } })
  .step('markSynced', { run: (c) => localDb.mark(c.input.orderId, 'synced') });

// later, when connectivity returns:
await syncOrder.execute({ orderId }, { idempotencyKey: `sync-${orderId}` });
```

With a SQLite/MMKV `StorageAdapter` the sync survives the app being force-closed.

### Background worker (Bull/BullMQ)

```ts
queue.process(async (job) => {
  return processOrderFlow.execute(job.data, {
    idempotencyKey: `job-${job.id}`,   // Bull may re-dispatch; kompensa dedupes
    signal: job.signal,                 // queue cancellation → flow abort
  });
});
```

---

## How it compares

| | **kompensa** | Temporal | AWS Step Functions | Bull / BullMQ | Plain try/catch |
| -- | :--: | :--: | :--: | :--: | :--: |
| In-process orchestration  | ✅ | ⚠️ needs worker | ❌ | ⚠️ | ✅ |
| Zero deps                 | ✅ | ❌ | ❌ | ❌ | ✅ |
| Works in browser / RN     | ✅ | ❌ | ❌ | ❌ | ✅ |
| Saga compensation         | ✅ | ✅ | ✅ | ❌ | ❌ |
| Durable state (crash-safe)| ✅ (w/ adapter) | ✅ | ✅ | ⚠️ | ❌ |
| Distributed workers       | ✅ | ✅ | ✅ | ✅ | ❌ |
| Long-running (days/weeks) | ❌ | ✅ | ✅ | ⚠️ | ❌ |
| Typed DSL                 | ✅ | ⚠️ | ❌ | ❌ | — |
| Bundle size               | ~20 KB | 10+ MB | — | ~200 KB | 0 |

**TL;DR:** kompensa sits between "roll your own" and "adopt a heavyweight orchestrator." It's the right tool when you want structured sagas inside a service — not when you need hour-scale durable workflows across a fleet of workers (use Temporal for that).

---

## Storage adapters

The core ships with `MemoryStorage` — fine for tests, single-process services, and offline/mobile use where durability isn't critical.

Writing a custom adapter is a 3-method interface:

```ts
import type { StorageAdapter, FlowState } from 'kompensa';

class MyStorage implements StorageAdapter {
  async load(flowName: string, flowId: string): Promise<FlowState | null> { ... }
  async save(state: FlowState): Promise<void>                              { ... }
  async delete(flowName: string, flowId: string): Promise<void>            { ... }
}
```

**Durable adapters (v0.2):**

```ts
// Postgres — state in JSONB, lock via pg_advisory_lock
import { Pool } from 'pg';
import { PostgresStorage } from 'kompensa/storage/postgres';
const storage = new PostgresStorage({ pool: new Pool({ connectionString }) });
await storage.ensureSchema();

// Redis — state as JSON, lock via SET NX PX with Lua-safe release
import Redis from 'ioredis';
import { RedisStorage } from 'kompensa/storage/redis';
const storage = new RedisStorage({ client: new Redis(REDIS_URL) });
```

Both survive worker crashes:
- **Postgres:** advisory lock releases when the holding connection closes
- **Redis:** lock released via token-guarded Lua script, TTL server-enforced

Integration tests run against real Postgres 17 + Redis 7 in CI. See [`docs/storage-adapters.md`](./docs/storage-adapters.md) for the full decision matrix.

---

## API surface

```ts
import {
  createFlow, Flow,
  FlowError, FlowAbortedError,
  PermanentError, TransientError, StepTimeoutError,
  MemoryStorage, createMemoryStorage,
  silentLogger, consoleLogger,
  computeDelay, shouldRetryError,
  isPermanent, isTransient, serializeError,
} from 'kompensa';

// Types
import type {
  StepContext, StepDefinition, RetryPolicy,
  ExecuteOptions, FlowConfig,
  FlowStatus, StepStatus, FlowState, StepState, SerializedError,
  StorageAdapter, Logger, FlowHooks,
  FlowStartEvent, FlowEndEvent,
  StepStartEvent, StepEndEvent, StepRetryEvent,
  CompensateEvent,
} from 'kompensa';
```

Full types exported. Every public function has a TSDoc block.

---

## Roadmap

- **v0.2** — durable storage (Postgres, Redis) · distributed locks · integration tests
- **v0.3** — parallel step groups · OpenTelemetry adapter · `useFlow()` React hook
- **v0.4** — scheduler integration (cron/delayed retries) · SQLite / AsyncStorage adapter for mobile

See [open issues](https://github.com/sirelves/kompensa/issues) and the [milestones](https://github.com/sirelves/kompensa/milestones).

---

## Contributing

```bash
git clone https://github.com/sirelves/kompensa.git
cd kompensa
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/
```

PRs welcome. Please run `npm test` + `npm run typecheck` before submitting.

---

## License

MIT © [sirelves](https://github.com/sirelves)
