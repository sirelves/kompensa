# Getting started

## Install

```bash
npm install flowguard
```

Requires Node 18+. Works in modern browsers and React Native (Hermes).

For durable state across process restarts you'll also want one of the adapters:

```bash
npm install flowguard pg          # Postgres (recommended for most backends)
npm install flowguard ioredis     # Redis  (good when you already run Redis)
```

Both are peer dependencies — flowguard itself has zero runtime dependencies.

## Your first flow

```ts
import { createFlow } from 'flowguard';

const signup = createFlow<{ email: string }>('signup')
  .step('createUser', {
    run: async (ctx) => ({ id: `u_${Date.now()}`, email: ctx.input.email }),
    compensate: async (_ctx, user) => console.log('delete user', user.id),
  })
  .step('sendWelcomeEmail', {
    run: async (ctx) => {
      console.log('→ email', ctx.results.createUser.id);
      return { messageId: 'm-1' };
    },
  });

const result = await signup.execute({ email: 'you@example.com' });
console.log(result);
// { createUser: { id: 'u_...', email: 'you@example.com' },
//   sendWelcomeEmail: { messageId: 'm-1' } }
```

Three things just happened:

1. **Type inference.** Inside `sendWelcomeEmail`, TypeScript knows `ctx.results.createUser.id` is a string — because `createUser`'s `run` returned `{ id, email }`.
2. **Compensation registered.** If `sendWelcomeEmail` had thrown, `createUser.compensate` would have fired automatically.
3. **State persisted.** By default flowguard uses `MemoryStorage`. Swap it for Postgres and the flow survives restarts.

## Make it idempotent

Pass an `idempotencyKey`. Re-running with the same key returns the cached result:

```ts
await signup.execute(
  { email: 'you@example.com' },
  { idempotencyKey: 'signup-you@example.com' },
);

// second call — no steps re-run, returns cached result
await signup.execute(
  { email: 'you@example.com' },
  { idempotencyKey: 'signup-you@example.com' },
);
```

Perfect for:
- Webhook handlers (provider retries the same event)
- HTTP endpoints with an `Idempotency-Key` header
- Message queue consumers (broker may re-deliver)

## Make it survive crashes

Plug in a durable adapter:

```ts
import { Pool } from 'pg';
import { PostgresStorage } from 'flowguard/storage/postgres';

const storage = new PostgresStorage({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
});
await storage.ensureSchema();   // one-time table creation

const signup = createFlow<{ email: string }>('signup', { storage })
  .step(/* ... */)
  .step(/* ... */);
```

Now if the process crashes between `createUser` and `sendWelcomeEmail`, a retry with the same `idempotencyKey` resumes from `sendWelcomeEmail` — `createUser` won't run twice.

## Retry transient failures

```ts
.step('callPaymentGateway', {
  run: async (ctx) => api.charge(ctx.input.amount),
  compensate: async (_ctx, charge) => api.refund(charge.id),
  retry: {
    maxAttempts: 3,
    backoff: 'exponential',
    initialDelayMs: 200,
    jitter: true,
  },
  timeout: 5_000,  // fail the attempt if it takes longer than 5s
})
```

Throw `PermanentError` to stop retries immediately (validation errors, 4xx responses). Throw `TransientError` to explicitly opt-in (429, 503, timeouts).

## Next steps

- [Concepts](./concepts.md) — deeper dive on state, compensation, and retry semantics
- [Storage adapters](./storage-adapters.md) — choosing between memory / Postgres / Redis
- [Recipes](./recipes/) — copy-pasteable patterns for common scenarios
