---
title: "The 4 classic bugs every multi-service Node.js app hits (and how to stop reinventing the wheel)"
published: false
description: "Duplicate charges, orphaned inventory, dumb retry loops, crash-mid-flow. Four bugs every team hits in production. I wrote a TypeScript library to solve them without adopting Temporal."
tags: node, typescript, webdev, opensource
cover_image: https://raw.githubusercontent.com/sirelves/kompensa/main/.github/assets/social-preview.png
canonical_url: https://github.com/sirelves/kompensa
---

Every time I read a post-mortem from a different team, at least one of these four bugs is in it.

Customer charged twice. Inventory locked because payment crashed. We hammered the Twilio API in a loop until we got banned. Or, the 3 a.m. classic, a pod died mid-flow and the retry ran everything from scratch, including the step that had already gone out.

Always the same four. And always someone reinventing (badly) the wheel to fix them.

This post is about those four bugs, why they keep showing up, and the library I wrote to stop reinventing them. It is called `kompensa`. It is on npm, TypeScript-native, 20 KB, zero runtime dependencies.

## Bug 1: the customer was charged twice

The most expensive scenario. Your checkout endpoint starts processing the order, the charge goes out to Stripe, but before the response comes back the client loses its connection. The mobile app has no idea if it went through, so it retries. Your API receives the POST again. And charges again.

Everyone's first fix: add a `processed_requests` table with a hash of the request body as a unique key, check it at the top of the handler. Works, until someone does an `UPDATE` on the customer's order without reprocessing payment and you realize the wrong key was in the wrong table. Or until someone adds a timestamp field to the request and every retry becomes a "new" request.

The right way is to make idempotency a first-class concept in your flow, not a side table, but the identifier that drives all behavior.

In `kompensa` you pass an `idempotencyKey` when you execute the flow. The first time, the flow runs for real. The second time with the same key, it returns the cached result without touching any side effect.

```ts
import { createFlow } from 'kompensa';

const checkout = createFlow<{ orderId: string }>('checkout')
  .step('charge', {
    run: async (ctx) => stripe.charge({
      amount: 9900,
      orderId: ctx.input.orderId,
    }),
  });

// First call: Stripe is hit.
const result1 = await checkout.execute(
  { orderId: 'ord_42' },
  { idempotencyKey: 'ord_42' },
);

// Second call with the same key: returns result1, Stripe is NOT called.
const result2 = await checkout.execute(
  { orderId: 'ord_42' },
  { idempotencyKey: 'ord_42' },
);
```

The rule: the key is a business identifier the client controls. The Stripe `Idempotency-Key` header works. The `order_id` works. `Date.now()` does NOT work, because every retry generates a new key and you are back to square one.

## Bug 2: the inventory got stuck because the payment crashed

The second most expensive bug, and the one that floods the support Slack.

The flow is: reserve stock, charge the card, issue an invoice, hand off to shipping. Suppose the reserve succeeds, the charge succeeds, but the invoice fails because the customer's tax ID came back invalid from the tax service.

The request breaks, you return a 500. But the stock is reserved. And the card is debited.

In the next 10 minutes you have two paths: either the customer complains (and you find out), or nobody complains and that SKU stays marked unavailable forever. On a normal day, this breaks your Black Friday.

The solution to this kind of flow is the **Saga pattern**. Each step has a semantic inverse. When a step fails, you walk backward through the steps that succeeded, running each inverse.

```ts
const checkout = createFlow<{ orderId: string }>('checkout')
  .step('reserveStock', {
    run: async (ctx) => inventory.reserve(ctx.input.orderId),
    compensate: async (_ctx, reservation) => inventory.release(reservation.id),
  })
  .step('charge', {
    run: async (ctx) => stripe.charge(ctx.input.orderId),
    compensate: async (_ctx, charge) => stripe.refund(charge.id),
  })
  .step('issueInvoice', {
    run: async (ctx) => taxService.issue(ctx.input.orderId),
    // no compensate: issuing the invoice is the last step, nothing to roll back
  });
```

If `issueInvoice` errors out, `stripe.refund` runs automatically, then `inventory.release` runs automatically, and the `FlowError` thrown by `execute()` carries the original error plus any compensation errors that happened along the way.

The important part: if the compensation itself fails (the refund didn't go through), that error is **collected**, not masked. You know both what broke and what couldn't be rolled back, which is the worst case, and needs to page a human immediately.

## Bug 3: the dumb retry loop that hammered the external API until it got banned

Less catastrophic, but it happens every week.

Someone wrote `while (true) { try { ... } catch {} }` around a call that sometimes fails. Or added a retry to axios/fetch without backoff. What this does: on a transient failure (503 from the provider, network timeout, 429 throttling), you bombard the upstream service in a loop until, two seconds later, you have either succeeded or been IP-banned.

A correct retry has three ingredients:

1. **Exponential backoff**: each attempt waits longer than the previous one.
2. **Jitter**: a bit of randomness so all your pods do not retry at the same time (thundering herd).
3. **Transient vs. permanent distinction**: a 400 will never succeed, so do not retry it.

```ts
import { createFlow, PermanentError, TransientError } from 'kompensa';

const flow = createFlow('payment').step('charge', {
  run: async (ctx) => {
    const res = await fetch('https://api.stripe.com/v1/charges', {
      method: 'POST',
      body: JSON.stringify(ctx.input),
      signal: ctx.signal,   // respects timeout and cancellation
    });

    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`stripe ${res.status}`);
    }
    if (!res.ok) {
      // 400, 401, 402, 404: no point retrying
      throw new PermanentError(`stripe rejected: ${res.status}`);
    }
    return res.json();
  },
  retry: {
    maxAttempts: 5,
    backoff: 'exponential',
    initialDelayMs: 200,
    maxDelayMs: 10_000,
    jitter: true,
  },
  timeout: 10_000,
});
```

With that you wait 200ms, 400ms, 800ms, 1.6s, 3.2s between attempts (with jitter randomizing each one). If it is a 400 from Stripe, zero retries. If it is a 503, retry with backoff up to the fifth attempt.

The difference between this and `while(true) try catch` is not academic: it is the difference between "your integration works under pressure" and "your IP got banned by Stripe and you need to open a ticket with them".

## Bug 4: the pod crashed mid-flow and the retry ran everything again

The subtlest one, and the most fatal when it happens.

Your service instance went down after charging the card but before creating the shipment. The job queue (BullMQ, SQS, whatever) re-delivers the job. The worker loads the payload, runs the flow from the top, and charges the customer again.

Idempotency from Bug 1 helps, but only if you have idempotency **inside** the flow. If your steps are hand-rolled try/catch blocks, an idempotent charge does not save you from double-booking shipping.

The correct fix is to **persist the flow state at every transition**, and on retry, continue from where it stopped. Every successful step writes a record. If the process dies, the next execution looks at the record and skips the completed steps.

In kompensa this is automatic once you plug in a durable adapter (Postgres or Redis):

```ts
import { Pool } from 'pg';
import { createFlow } from 'kompensa';
import { PostgresStorage } from 'kompensa/storage/postgres';

const storage = new PostgresStorage({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
});
await storage.ensureSchema();  // creates the kompensa_states table

const checkout = createFlow<CheckoutInput>('checkout', { storage })
  .step('reserveStock', { run: reserveStock, compensate: releaseStock })
  .step('charge',       { run: charge,       compensate: refund       })
  .step('ship',         { run: ship                                    });

// Worker processing a job
worker.process(async (job) => {
  return checkout.execute(job.data, {
    idempotencyKey: `order-${job.data.orderId}`,
  });
});
```

If the worker crashes after `charge` but before `ship`, the next consumer that picks up the same job (with the same idempotencyKey) loads the persisted state, sees that `charge` already finished as `success`, and continues straight to `ship`. No duplicate charge, no duplicate reservation.

On top of that, the Postgres adapter holds a `pg_advisory_lock` on the connection, so even if two workers race for the same job at the same time, only one passes the "load state" gate. The other one waits or fails fast (configurable), depending on your policy.

## Putting it all together

The honest way to show this is a full checkout: reserve, charge, invoice.

```ts
import { Pool } from 'pg';
import { createFlow, FlowError, LockAcquisitionError } from 'kompensa';
import { PostgresStorage } from 'kompensa/storage/postgres';

const storage = new PostgresStorage({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
});
await storage.ensureSchema();

const checkout = createFlow<CheckoutInput>('checkout', {
  storage,
  lockWaitMs: 0,   // if another worker is already processing this key, fail fast
  defaultRetry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 200 },
})
  .step('reserveStock', {
    run:        (ctx) => inventory.reserve(ctx.input.items),
    compensate: (_ctx, res) => inventory.release(res.reservationId),
  })
  .step('charge', {
    run:        (ctx) => stripe.charge(ctx.input.userId, ctx.input.amount),
    compensate: (_ctx, c) => stripe.refund(c.id),
    timeout: 10_000,
  })
  .step('issueInvoice', {
    run: (ctx) => taxService.issue(ctx.input.orderId, ctx.results.charge.id),
  });

app.post('/checkout', async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) return res.status(400).json({ error: 'missing key' });

  try {
    const result = await checkout.execute(req.body, { idempotencyKey });
    res.json(result);
  } catch (err) {
    if (err instanceof LockAcquisitionError) {
      return res.status(409).json({ error: 'in progress, retry shortly' });
    }
    if (err instanceof FlowError) {
      // Everything already compensated. Client sees a clean business error.
      return res.status(422).json({
        error: err.message,
        failedAt: err.failedStep,
      });
    }
    throw err;
  }
});
```

Twenty lines of endpoint and you get:

- Idempotency (the client can retry freely).
- Exponential backoff with jitter on the payment step.
- Per-step timeout.
- Saga compensation on the inventory and card.
- Distributed lock, so you never have two workers on the same key.
- Resume after crash.
- Structured errors separating "another worker is processing this" from "the flow failed and was already rolled back".

Compare that with the nested try/catch version that usually lives there. Not the same language.

## When NOT to use this

Being honest with myself and with you: kompensa has a deliberately small scope.

If your workflow runs for days, has steps waiting for human approval, needs deterministic history replay, or has to coordinate across a fleet of workers with cross-workflow signals, you want **Temporal** or **AWS Step Functions**. Kompensa does not replace either of them. It lives inside your process, the flow runs in seconds to minutes, and it has no history, no replay, no separate worker service.

It is the reliability layer inside your service, not an external orchestrator.

For most checkouts, onboardings, order syncs, and payment flows I have seen, that is what you actually need. Temporal is overkill for 90 percent of cases.

## Try it

```bash
npm install kompensa
```

The code is open on GitHub, fully TypeScript, zero runtime dependencies, ESM plus CJS. It ships with 73 tests (50 unit plus 23 integration against real Postgres 17 and Redis 7), including a crash simulation that uses `pg_terminate_backend` to prove the lock releases when the worker dies.

Feedback is welcome. MIT, at [github.com/sirelves/kompensa](https://github.com/sirelves/kompensa).

Anyone who has ever lost a night debugging stuck inventory will understand.
