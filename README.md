<div align="center">

# kompensa

**Saga pattern workflow library for Node.js, browser and React Native.**
Typed builder · idempotency keys · retry with exponential backoff · compensation on failure · distributed locking · crash recovery.
Zero runtime dependencies.

[![npm version](https://img.shields.io/npm/v/kompensa?color=cb3837&logo=npm)](https://www.npmjs.com/package/kompensa)
[![npm downloads/month](https://img.shields.io/npm/dm/kompensa?color=cb3837&logo=npm&label=downloads%2Fmonth)](https://www.npmjs.com/package/kompensa)
[![npm downloads/week](https://img.shields.io/npm/dw/kompensa?color=cb3837&logo=npm&label=downloads%2Fweek)](https://www.npmjs.com/package/kompensa)
[![bundle size](https://img.shields.io/bundlephobia/minzip/kompensa?label=minzipped)](https://bundlephobia.com/package/kompensa)
[![types](https://img.shields.io/npm/types/kompensa)](https://www.npmjs.com/package/kompensa)
[![node](https://img.shields.io/node/v/kompensa)](https://www.npmjs.com/package/kompensa)
[![license](https://img.shields.io/npm/l/kompensa?color=blue)](./LICENSE)
[![CI](https://github.com/sirelves/kompensa/actions/workflows/ci.yml/badge.svg)](https://github.com/sirelves/kompensa/actions/workflows/ci.yml)

[📚 Docs](./docs) · [🚀 Getting started](./docs/getting-started.md) · [🧩 Recipes](./docs/recipes) · [⚖️ Compare](./docs/comparison.md) · [❓ FAQ](./docs/faq.md) · [📈 Download trends](https://npm-stat.com/charts.html?package=kompensa) · [📦 npm](https://www.npmjs.com/package/kompensa) · [🐙 GitHub](https://github.com/sirelves/kompensa)

</div>

---

## Install

```bash
npm  install kompensa
pnpm add     kompensa
yarn add     kompensa
bun  add     kompensa
```

Requires **Node.js 18+**. Works in modern browsers, Deno, Bun, and **React Native** (Hermes). Ships with **ESM + CJS** and full **TypeScript** declarations.

---

## 30 seconds

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

If `charge` fails → `reserve` is **compensated automatically** (saga rollback).
Re-running with the same `idempotencyKey` → returns the **cached result** (no duplicate charge).
Process crashed mid-flow? → **resumes from the last successful step** (with a durable adapter).

---

## What is kompensa?

**kompensa** is a small, type-safe **saga pattern library** for JavaScript and TypeScript that handles the four hardest problems of multi-step workflows in production:

1. **Idempotency** — re-running the same work with the same key returns the cached result. No more duplicate payments, duplicate orders, or duplicate emails when clients retry.
2. **Retry with exponential backoff and jitter** — transient failures (timeouts, 429, 503) are retried intelligently. Permanent failures (400, business errors) stop immediately.
3. **Compensation (the Saga pattern)** — when a step fails, previous successful steps are rolled back automatically in reverse order. No partial state leaks.
4. **Crash recovery** — every step transition is persisted. If the process dies mid-flow, the next invocation resumes from the last completed step.

It's an **in-process, lightweight alternative to Temporal, Cadence, or AWS Step Functions** — designed for teams that need structured saga handling inside a Node.js service, a React Native app, or a BullMQ worker, without adopting a heavyweight orchestrator.

---

## Problems kompensa solves

| Problem                                                  | Without kompensa                              | With kompensa                                                      |
| -------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| **Duplicate payment / duplicate order bugs**             | Client retries, customer billed twice         | `idempotencyKey` → result cached, side effects not replayed        |
| **Partial failure leaks (stock reserved, charge failed)**| Orphaned state, manual cleanup, on-call pages | Saga `compensate` runs on downstream failure, in reverse order     |
| **Dumb retry loops (hammering APIs on 4xx)**             | Infinite retries, rate-limit bans             | `PermanentError` stops retries; `TransientError` retries w/ jitter |
| **Chain of hung requests (one stuck call blocks all)**   | Whole flow frozen                             | Per-step `timeout`, `StepTimeoutError` retryable by default        |
| **Crash = lost work**                                    | Retry the whole flow from scratch             | **Resume** from the last successful step (durable adapter)         |
| **Multi-worker racing same key**                         | Both execute, both charge                     | Distributed lock via Postgres advisory / Redis Redlock             |

---

## When should I use kompensa?

✅ **Use kompensa when:**

- You're building an **HTTP endpoint** that touches 2+ services and needs to be safely retried by the client (checkout, signup, booking)
- You're processing **jobs in a queue** (BullMQ, pg-boss, SQS) where the broker may re-deliver and you need dedup + rollback
- You're building an **offline-first mobile app** (React Native) that syncs pending work when connectivity returns
- You want **saga pattern** semantics in TypeScript without adopting Temporal's worker infrastructure
- You need **idempotency keys** at the HTTP layer (Stripe-style `Idempotency-Key` header)
- You want **typed** retry, compensation and state machine primitives — not hand-rolled try/catch

❌ **Look elsewhere when:**

- You need workflows that span **days or weeks** with human-in-the-loop steps → use [Temporal](https://temporal.io/)
- You need **signal routing** and cross-workflow orchestration at scale → Temporal or Step Functions
- You're happy with **plain try/catch** in a 2-step flow — no need to add a dependency

---

## Quick start by use case

### ⚡ Backend HTTP endpoint (Express / Fastify / Next.js / NestJS)

```ts
import { Pool } from 'pg';
import { createFlow, FlowError } from 'kompensa';
import { PostgresStorage } from 'kompensa/storage/postgres';

const storage = new PostgresStorage({ pool: new Pool({ connectionString }) });
await storage.ensureSchema();

const checkout = createFlow<CheckoutInput>('checkout', { storage })
  .step('reserve', { run: reserveStock, compensate: releaseStock })
  .step('charge',  { run: charge,       compensate: refund,      retry: { maxAttempts: 3 } })
  .step('invoice', { run: issueInvoice });

app.post('/checkout', async (req, res) => {
  try {
    const result = await checkout.execute(req.body, {
      idempotencyKey: req.header('Idempotency-Key'),
    });
    res.json(result);
  } catch (err) {
    if (err instanceof FlowError) {
      res.status(409).json({ failedAt: err.failedStep, message: err.message });
    }
  }
});
```

### 📦 Background worker (BullMQ / Bull / pg-boss)

```ts
import { Worker } from 'bullmq';
import { createFlow } from 'kompensa';
import { RedisStorage } from 'kompensa/storage/redis';

const flow = createFlow('process-order', {
  storage: new RedisStorage({ client: redis }),
  lockWaitMs: 0,  // if another worker has this job, don't queue behind
})
  .step('charge',  { run: charge,  compensate: refund })
  .step('ship',    { run: ship });

new Worker('orders', async (job) => {
  return flow.execute(job.data, { idempotencyKey: `order-${job.data.id}` });
});
```

### 📱 Mobile offline sync (React Native / Expo)

```tsx
import { createFlow, TransientError } from 'kompensa';
import { SqliteStorage } from './SqliteStorage';  // 30-line adapter, see docs

const syncOrder = createFlow<{ orderId: string }>('sync-order', {
  storage: new SqliteStorage(db),  // survives app force-close
})
  .step('upload', {
    run: async (ctx) => api.post('/orders', ctx.input),
    retry: { maxAttempts: 5, backoff: 'exponential', initialDelayMs: 500 },
  })
  .step('markSynced', {
    run: async (ctx) => localDb.mark(ctx.input.orderId, 'synced'),
  });

NetInfo.addEventListener(async (net) => {
  if (net.isConnected) {
    for (const o of await pendingOrders()) {
      syncOrder.execute({ orderId: o.id }, { idempotencyKey: `sync-${o.id}` });
    }
  }
});
```

---

## How does kompensa compare to alternatives?

| Capability                     | **kompensa** | Temporal         | AWS Step Functions | BullMQ         | Plain try/catch |
| ------------------------------ | :----------: | :--------------: | :----------------: | :------------: | :-------------: |
| In-process orchestration       | ✅            | ⚠️ needs worker  | ❌                 | ⚠️              | ✅               |
| Zero runtime dependencies      | ✅            | ❌               | ❌                 | ❌              | ✅               |
| Works in browser / React Native| ✅            | ❌               | ❌                 | ❌              | ✅               |
| Saga compensation (auto rollback)| ✅          | ✅               | ✅                 | ❌              | ❌              |
| Idempotency out of the box     | ✅            | ✅               | ✅                 | ⚠️ manual       | ❌              |
| Crash recovery / resume        | ✅ (w/ adapter)| ✅             | ✅                 | ⚠️              | ❌              |
| Distributed locks              | ✅            | ✅               | ✅                 | ✅              | ❌              |
| Long-running (days / weeks)    | ❌            | ✅               | ✅                 | ⚠️              | ❌              |
| Typed DSL (TypeScript)         | ✅            | ⚠️               | ❌                 | ❌              | —               |
| Bundle size                    | ~20 KB       | 10+ MB server    | —                  | ~200 KB        | 0               |
| Setup time                     | 2 minutes    | 2 hours          | 1 hour             | 30 min         | 0               |

**Short version:** kompensa sits between "roll your own" and "adopt a heavyweight orchestrator". If your workflows finish in seconds to minutes and live inside a single service, kompensa is enough. If you need cross-process, long-running durable state, reach for Temporal.

---

## Compatibility

| Runtime            | Supported | Notes                                                     |
| ------------------ | :-------: | --------------------------------------------------------- |
| Node.js 18 / 20 / 22 | ✅       | CI runs all three                                         |
| Bun                | ✅        | ESM + CJS, no Node-specific APIs in core                  |
| Deno               | ✅        | ESM import, use `npm:kompensa`                            |
| Browsers (modern)  | ✅        | Core is isomorphic, `MemoryStorage` works                 |
| React Native (Hermes) | ✅     | Needs polyfill for `structuredClone` on very old versions |
| Cloudflare Workers | ✅        | Core works; storage adapter needs to be KV-backed         |

| Framework / tool     | Integration | Example                                               |
| -------------------- | :---------: | ----------------------------------------------------- |
| Express / Fastify    | ✅          | Wrap endpoint in `flow.execute()` with idempotencyKey |
| Next.js App Router   | ✅          | Route handler or server action                        |
| NestJS               | ✅          | Inject flow via provider                              |
| BullMQ / Bull        | ✅          | `flow.execute(job.data, { idempotencyKey: job.id })`  |
| pg-boss              | ✅          | Same pattern as BullMQ                                |
| AWS SQS / Lambda     | ✅          | Lambda handler wraps flow                             |
| Expo / React Native  | ✅          | SqliteStorage / MMKV adapter for offline              |

| Storage adapter      | Built-in | Package                                | Use for                          |
| -------------------- | :------: | -------------------------------------- | -------------------------------- |
| Memory               | ✅       | `kompensa`                             | tests, single-process, offline   |
| **PostgreSQL**       | ✅       | `kompensa/storage/postgres` + `pg`     | most backends                    |
| **Redis**            | ✅       | `kompensa/storage/redis` + `ioredis`   | when Redis is already in stack   |
| SQLite / AsyncStorage/ MMKV | 🔌 DIY | your adapter (~30 lines)        | mobile / RN offline              |
| DynamoDB, MongoDB, … | 🔌 DIY   | your adapter                           | other clouds                     |

---

## Feature matrix

| Feature                                         | Status   |
| ----------------------------------------------- | :------: |
| Fluent builder with typed result accumulation   | ✅       |
| Idempotency via execution key                   | ✅       |
| Retry — fixed / linear / exponential + jitter   | ✅       |
| Saga compensation (reverse order on failure)    | ✅       |
| Per-step timeout                                | ✅       |
| AbortSignal cancellation                        | ✅       |
| Lifecycle hooks (start/retry/end/compensate)    | ✅       |
| Persistent state (resume after crash)           | ✅       |
| `MemoryStorage` adapter                         | ✅       |
| `PostgresStorage` with advisory lock            | ✅ v0.2  |
| `RedisStorage` with Redlock-style lock          | ✅ v0.2  |
| Distributed lock (multi-worker safety)          | ✅ v0.2  |
| Parallel step groups (fan-out/fan-in)           | ✅ v0.3  |
| OpenTelemetry adapter                           | 🗓️ v0.3 |
| `useFlow()` React hook                          | 🗓️ v0.3 |

---

## Core concepts

Steps declare `run` and an optional `compensate`. Results accumulate into `ctx.results` — **fully typed**:

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

**Retry policy** (per step or flow-wide):

```ts
retry: {
  maxAttempts: 3,
  backoff: 'exponential',   // 'fixed' | 'linear' | 'exponential'
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  jitter: true,             // true | false | 0..1 fraction
  shouldRetry: (err, n) => err.code !== 'E_FORBIDDEN',
}
```

Throw `PermanentError` to dead-stop retries; `TransientError` is always eligible.

**Parallel step groups (fan-out / fan-in)** — call `.parallel(name, branches, options?)` instead of `.step()` when you have independent work that should run concurrently:

```ts
createFlow<{ orderId: string }>('checkout')
  .parallel('externals', {
    pricing:  { run: (ctx) => api.pricing(ctx.input.orderId) },
    shipping: { run: (ctx) => api.shipping(ctx.input.orderId) },
    tax:      { run: (ctx) => api.tax(ctx.input.orderId), retry: { maxAttempts: 3 } },
  })
  .step('charge', {
    run: (ctx) => charge(ctx.results.externals.pricing.amount),
    //                              ^^^^^^^^^ each branch is statically typed
  });
```

Branches run via `Promise.all` with a shared `AbortSignal` — when one fails, siblings are aborted (fail-fast by default; pass `{ abortOnFailure: false }` to disable). Compensation runs in parallel by default; pass `{ compensateSerially: true }` for reverse-completion-order rollback when there is a causal dependency. Crash recovery skips already-`success` branches on resume.

**Idempotency** states:

| Prior state     | Behavior                                                  |
| --------------- | --------------------------------------------------------- |
| `success`       | Returns cached result, skips all steps                    |
| `compensated`   | Re-throws the original `FlowError`                        |
| `running` (crash)| Resumes from the first non-`success` step                |
| _(none)_        | Normal execution                                          |

See **[docs/concepts.md](./docs/concepts.md)** for the full state machine, lock protocol, and observability hooks.

---

## FAQ

### How do I prevent duplicate charges when a client retries my payment API?

Pass a stable `idempotencyKey` (typically the `Idempotency-Key` HTTP header, the order ID, or a business-unique value):

```ts
await checkout.execute(body, { idempotencyKey: req.header('Idempotency-Key') });
```

The first call runs. Subsequent calls with the same key return the cached result without re-running the flow — so your payment provider is only hit once.

### How does kompensa handle partial failures? (What is the Saga pattern?)

Every step can declare a `compensate` function — the semantic inverse of `run`. If a later step fails, kompensa walks backwards through successful steps and calls each one's `compensate`. Example:

```
reserve (✅) → charge (✅) → ship (❌ fails)
                ↓ compensation runs automatically
refund         ←  release stock
```

This is the **Saga pattern**. Your `FlowError` contains both the original failure and any errors that occurred during rollback.

### How is this different from Temporal?

Temporal is a heavyweight durable-workflow platform with its own worker infrastructure, history storage, and replay-based execution model — great for multi-day workflows across fleets of workers. kompensa is a small **in-process** library: no worker, no history server, no replay model. Workflows live in your Node process and finish in seconds to minutes. Use Temporal when you need cross-worker coordination over hours/days; use kompensa when you want saga semantics without the ops cost.

### Can I use kompensa with BullMQ / Bull?

Yes — kompensa and BullMQ compose naturally. BullMQ handles job scheduling and distribution; kompensa handles the inside of each job. The distributed lock prevents two workers from processing the same job ID at once, and idempotency means broker re-delivery is safe:

```ts
new Worker('orders', async (job) => {
  return flow.execute(job.data, { idempotencyKey: `order-${job.data.id}` });
});
```

### Does kompensa work with Next.js?

Yes. Use it in any route handler, server action, or API route. Plug in `PostgresStorage` for crash recovery across deploys and a distributed lock that prevents two Next.js instances from racing on the same key.

### Can I use kompensa in React Native for offline sync?

Yes. That's exactly one of its target use cases. Write a small `StorageAdapter` backed by SQLite (`expo-sqlite`) or MMKV (~30 lines). When the app is backgrounded or force-closed mid-sync, the next launch resumes from the last successful step — no duplicate server-side work.

### What happens if my worker crashes mid-flow?

Every step transition is persisted to the storage adapter before the step runs. If the process dies between step `B` and step `C`, the next invocation with the same `idempotencyKey` loads the persisted state and resumes at step `C`. Step `B` does **not** run again (its side effects happened once). Use a durable adapter (`PostgresStorage` or `RedisStorage`) for real crash recovery — `MemoryStorage` is wiped on restart.

### How do I do exponential backoff retries in Node.js with kompensa?

```ts
.step('callApi', {
  run: async (ctx) => fetch(url, { signal: ctx.signal }),
  retry: {
    maxAttempts: 5,
    backoff: 'exponential',
    initialDelayMs: 200,
    maxDelayMs: 30_000,
    jitter: true,           // recommended — prevents thundering herd
  },
  timeout: 10_000,
})
```

Transient errors retry automatically. Throw `PermanentError` to stop retries on 4xx responses.

### How do I test saga compensation logic?

Use `MemoryStorage` in unit tests — no database required:

```ts
import { createFlow, MemoryStorage, FlowError } from 'kompensa';

const releaseSpy = vi.fn();
const flow = createFlow('x', { storage: new MemoryStorage() })
  .step('reserve', { run: () => ({ id: 'r1' }), compensate: () => releaseSpy() })
  .step('charge',  { run: () => { throw new Error('fail'); } });

await expect(flow.execute({})).rejects.toBeInstanceOf(FlowError);
expect(releaseSpy).toHaveBeenCalledOnce();
```

See **[docs/testing.md](./docs/testing.md)** for more patterns.

### Is kompensa production-ready?

kompensa runs **73 tests** (50 unit + 23 integration) against real Postgres 17 and Redis 7 in CI — covering concurrency, crash recovery, lock TTL expiry, token-safe release, and resume-after-crash. It's pre-1.0, so minor versions may still have breaking API changes; pin exact versions until 1.0 or read the [CHANGELOG](./CHANGELOG.md).

---

## Storage adapters

```ts
// In-memory (default) — tests, single-process, offline
import { MemoryStorage } from 'kompensa';

// Postgres — JSONB state + pg_advisory_lock
import { Pool } from 'pg';
import { PostgresStorage } from 'kompensa/storage/postgres';
const storage = new PostgresStorage({ pool: new Pool({ connectionString }) });
await storage.ensureSchema();

// Redis — SET NX PX with Lua-safe release
import Redis from 'ioredis';
import { RedisStorage } from 'kompensa/storage/redis';
const storage = new RedisStorage({ client: new Redis(REDIS_URL) });
```

Both durable adapters survive worker crashes:
- **Postgres** — advisory lock releases when the holding connection closes
- **Redis** — token-verified Lua release script, TTL server-enforced

Writing a custom adapter (SQLite / DynamoDB / KV / in-memory / etc.) is a 3-method interface plus an optional lock. See **[docs/storage-adapters.md](./docs/storage-adapters.md)** for the decision matrix and a 30-line SQLite example for mobile.

---

## API surface

```ts
import {
  createFlow, Flow,
  FlowError, FlowAbortedError, LockAcquisitionError,
  PermanentError, TransientError, StepTimeoutError,
  MemoryStorage, createMemoryStorage,
  silentLogger, consoleLogger,
  computeDelay, shouldRetryError,
  isPermanent, isTransient, serializeError,
} from 'kompensa';

import type {
  StepContext, StepDefinition, RetryPolicy,
  ExecuteOptions, FlowConfig,
  FlowStatus, StepStatus, FlowState, StepState, SerializedError,
  StorageAdapter, Lock, AcquireLockOptions, Logger, FlowHooks,
  FlowStartEvent, FlowEndEvent,
  StepStartEvent, StepEndEvent, StepRetryEvent,
  CompensateEvent,
} from 'kompensa';
```

See **[docs/api.md](./docs/api.md)** for the full reference, or the [TSDoc](./src) in the source.

---

## Roadmap

- **v0.2** ✅ — durable storage (Postgres, Redis) · distributed locks · integration tests
- **v0.3** 🚧 — **parallel step groups (fan-out/fan-in) ✅** · OpenTelemetry adapter · `useFlow()` React hook
- **v0.4** — scheduler integration (cron / delayed retries) · SQLite adapter for mobile

Track progress in [issues](https://github.com/sirelves/kompensa/issues) and [milestones](https://github.com/sirelves/kompensa/milestones).

---

## Contributing

```bash
git clone https://github.com/sirelves/kompensa.git
cd kompensa
npm install
npm test                   # 50 unit tests
npm run test:services:up   # spin up Postgres + Redis containers
npm run test:integration   # 23 integration tests
npm run typecheck          # tsc --noEmit
npm run build              # tsup → dist/
```

PRs welcome. Please run `npm test` + `npm run typecheck` before submitting.

---

## License

**MIT** © [sirelves](https://github.com/sirelves)
