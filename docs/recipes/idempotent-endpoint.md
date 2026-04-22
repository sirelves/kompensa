# Recipe: idempotent HTTP endpoint

Your POST endpoint touches several services. The client can retry. You must not double-charge, double-ship, or double-email.

## Complete example

```ts
import express from 'express';
import { Pool } from 'pg';
import { createFlow, FlowError, LockAcquisitionError } from 'sagaflow';
import { PostgresStorage } from 'sagaflow/storage/postgres';

const storage = new PostgresStorage({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
});
await storage.ensureSchema();

const checkout = createFlow<{ orderId: string; userId: string; amount: number }>('checkout', {
  storage,
  lockWaitMs: 0,  // fail fast — the client will retry
})
  .step('reserveStock', {
    run: async (ctx) => api.inventory.reserve(ctx.input.orderId),
    compensate: async (_c, reservation) => api.inventory.release(reservation.id),
  })
  .step('charge', {
    run: async (ctx) => api.payment.charge(ctx.input.userId, ctx.input.amount),
    compensate: async (_c, charge) => api.payment.refund(charge.id),
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 200 },
    timeout: 5_000,
  })
  .step('sendReceipt', {
    run: async (ctx) => api.email.send({
      to: ctx.input.userId,
      chargeId: ctx.results.charge.id,
    }),
  });

const app = express();
app.use(express.json());

app.post('/checkout', async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header required' });
  }

  try {
    const result = await checkout.execute(req.body, { idempotencyKey });
    res.json(result);
  } catch (err) {
    if (err instanceof LockAcquisitionError) {
      // Another worker is running this key right now. Client should retry.
      return res.status(409).json({ error: 'in progress, retry shortly' });
    }
    if (err instanceof FlowError) {
      // Business failure — stock released + payment refunded already.
      return res.status(422).json({
        error: err.message,
        failedStep: err.failedStep,
        compensations: err.compensationErrors.map((c) => c.step),
      });
    }
    throw err;  // unknown — let the error middleware handle it
  }
});
```

## What you get

- **First request:** all three steps run, response returned.
- **Retry with same header:** sagaflow short-circuits, returns the identical response body — no side effects.
- **Retry while first call is still running:** 409, client backs off and retries again (with a successful short-circuit).
- **Payment failure:** stock is released automatically. Client sees 422 with the failed step.
- **Worker crashes mid-flow:** next request with the same key resumes from the last completed step — no double-charge.

## Pitfalls to avoid

- **Don't put `Date.now()` in the idempotency key.** Then every retry gets a fresh key and the whole point is lost.
- **Don't derive the key from the full request body.** Two retries with slightly different bodies (whitespace, reordered fields) become two keys.
- **Good key:** client-provided `Idempotency-Key` header, or a business identifier like `order-{orderId}`.
- **Don't rely on `MemoryStorage`.** In a multi-worker deployment each worker has its own Map. Use Postgres or Redis.
