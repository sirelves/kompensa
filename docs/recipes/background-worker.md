# Recipe: background worker (Bull / BullMQ)

Your job queue may re-deliver a job (consumer crashed, visibility timeout, broker replay). Wrap the job handler in a flow so the work is idempotent, resumable, and auto-compensated on partial failure.

## Complete example (BullMQ)

```ts
import { Worker, Queue } from 'bullmq';
import { Pool } from 'pg';
import { createFlow, FlowError, LockAcquisitionError } from 'flowguard';
import { PostgresStorage } from 'flowguard/storage/postgres';

const storage = new PostgresStorage({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
});

const processOrder = createFlow<{ orderId: string }>('process-order', {
  storage,
  lockWaitMs: 0, // if another worker has this job, don't queue behind them
})
  .step('fetchOrder', {
    run: async (ctx) => db.orders.findOne(ctx.input.orderId),
  })
  .step('reserveInventory', {
    run: async (ctx) => api.inventory.reserve(ctx.results.fetchOrder.items),
    compensate: async (_c, reservation) => api.inventory.release(reservation.id),
  })
  .step('charge', {
    run: async (ctx) => api.payment.charge(
      ctx.results.fetchOrder.userId,
      ctx.results.fetchOrder.total,
    ),
    compensate: async (_c, charge) => api.payment.refund(charge.id),
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 500 },
    timeout: 10_000,
  })
  .step('shipOrder', {
    run: async (ctx) => api.shipping.create({
      orderId: ctx.input.orderId,
      paymentId: ctx.results.charge.id,
    }),
  });

new Worker<{ orderId: string }>(
  'orders',
  async (job) => {
    try {
      return await processOrder.execute(job.data, {
        idempotencyKey: `order-${job.data.orderId}`,
      });
    } catch (err) {
      if (err instanceof LockAcquisitionError) {
        // Another worker is already processing this order. BullMQ will retry
        // via its own retry policy — or if the other worker succeeds, our
        // subsequent retry will short-circuit with the cached result.
        throw err;
      }
      if (err instanceof FlowError) {
        // Compensation already ran. Tell BullMQ the job failed permanently.
        // The order is in a safe state — no half-processed side effects.
        job.discard();
        throw err;
      }
      throw err; // unknown — let BullMQ retry
    }
  },
  { connection: redis, concurrency: 10 },
);
```

## Why this combination shines

Queue retries + flowguard idempotency work together:

- **Queue re-delivers** → flowguard sees the same `idempotencyKey`, short-circuits to the cached result. BullMQ marks the job done.
- **Queue re-delivers after partial work** → flowguard resumes from the last completed step. No duplicate payments.
- **Queue backpressure throttles concurrency** → distributed lock ensures even under burst load, only one worker processes any given order at a time.
- **Compensation runs automatically** → if `shipOrder` fails after `charge`, the customer is refunded before the job is marked failed.

## Signal forwarding

BullMQ gives each job an `AbortSignal` that fires when the job is cancelled. Forward it into the flow:

```ts
new Worker('orders', async (job, { signal }) => {
  return await processOrder.execute(job.data, {
    idempotencyKey: `order-${job.data.orderId}`,
    signal,                              // cancellation → compensation
  });
});
```

Now cancelling the job also triggers flowguard's compensation — useful when a user cancels the order mid-processing.
