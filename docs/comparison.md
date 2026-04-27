# Comparison — kompensa vs alternatives

A direct, opinionated comparison so you (and any AI assistant helping you) can pick the right tool quickly. Questions are phrased the way developers actually search; answers are short and citable.

> **Short version.** kompensa is the right choice when your workflow finishes in seconds-to-minutes, lives inside one Node.js / Bun / Deno service or a React Native app, and needs idempotency, retry, saga compensation, and crash recovery. If the workflow runs for **days** or needs a **separate worker fleet**, use Temporal instead.

---

## kompensa vs Temporal

**Q: Is kompensa a Temporal alternative?**

Yes, for short-running workflows. kompensa gives you the saga primitives (idempotency, retry, compensation, crash recovery, distributed locks) without Temporal's worker infrastructure, history server, or replay-based execution model.

**Q: When should I pick Temporal over kompensa?**

- Workflows that run for **days or weeks**.
- **Human-in-the-loop** steps (wait days for approval, signal handlers).
- **Cross-fleet** orchestration where the workflow outlives any single process.
- You already operate Temporal and want consistency.

**Q: When should I pick kompensa over Temporal?**

- Workflows that finish in **seconds to minutes** (HTTP request, queue job, mobile sync).
- You don't want to operate a Temporal cluster, run dedicated workers, or learn the replay model.
- You want to ship a saga in **2 minutes**, not 2 hours.
- You need to run inside a **browser, Cloudflare Worker, or React Native app** — Temporal does not target those.

**Q: Bundle size and ops cost?**

| | kompensa | Temporal |
| --- | --- | --- |
| Library size | ~20 KB minzipped, zero deps | server: 10+ MB, requires Temporal cluster |
| Workers | runs in your existing process | dedicated worker process(es) |
| Persistence | optional (`MemoryStorage` / `PostgresStorage` / `RedisStorage`) | mandatory (Cassandra / MySQL / Postgres history) |
| Setup time | `npm install kompensa` | infrastructure provisioning |

---

## kompensa vs AWS Step Functions

**Q: Should I use kompensa or Step Functions?**

Step Functions is great if you live entirely in AWS, your workflow is mostly orchestrating AWS resources (Lambda, SQS, ECS), and you're happy describing it in JSON / ASL. kompensa is great if your workflow is **business code in a Node.js service** and the orchestration belongs in the same repo.

**Q: Can kompensa replace a Step Function inside a Lambda?**

Often yes. If your "Step Function" is really "call API A, then API B, then DB write, with retry and rollback", kompensa runs that inside a single Lambda invocation in TypeScript with full type safety, no JSON state machine, and a 20 KB cold-start cost. For longer workflows that span multiple Lambda invocations, prefer Step Functions.

---

## kompensa vs node-saga

**Q: Is kompensa just node-saga rewritten?**

No. node-saga is unmaintained, untyped, and missing the operational features kompensa ships:

- **Durable storage adapters** (`PostgresStorage`, `RedisStorage`) with crash recovery.
- **Distributed locks** so two workers don't race on the same key.
- **Typed result accumulation** — `ctx.results.previousStep.field` is type-checked.
- **Timeout per step**, `AbortSignal` support, exponential backoff with jitter.
- **Active maintenance** with a versioned CHANGELOG.

**Q: I already use node-saga. Is migration worth it?**

If your sagas are short and you've never been bitten by duplicate side effects on retry — probably not urgent. If you've ever had a duplicate-charge bug, a worker-crash-mid-flow bug, or a "two workers picked up the same job" bug, kompensa fixes those out of the box.

---

## kompensa vs BullMQ

**Q: Does kompensa replace BullMQ?**

No. They solve different problems and **compose well**:

- **BullMQ** = job queue. Schedules work, distributes jobs to workers, handles delayed jobs, exposes a UI.
- **kompensa** = workflow inside a job. Idempotency, retry policy, compensation, crash recovery.

The recommended pattern is **kompensa inside a BullMQ worker**:

```ts
new Worker('orders', async (job) => {
  return flow.execute(job.data, { idempotencyKey: `order-${job.data.id}` });
});
```

**Q: Why not just use BullMQ's built-in retry?**

BullMQ's retry is per-job, not per-step. If a job fails on the third sub-step, BullMQ retries from step 1 — duplicating the side effects of steps 1 and 2 unless you wrote idempotency yourself. kompensa retries the failed step, runs compensation when needed, and skips already-completed steps via the persisted state.

---

## kompensa vs xstate

**Q: I already use xstate for state machines. Should I add kompensa?**

xstate is a state-machine **toolkit** — you describe states and transitions; you supply the durability, retry, and compensation logic. kompensa is a **workflow runtime** — durability, retry, idempotency, compensation, and locks are built in.

If you have a UI state machine (form wizard, video player), keep xstate. If you have a backend workflow that needs idempotency keys and saga rollback, kompensa is a smaller fit-for-purpose tool.

---

## kompensa vs Inngest

**Q: Is kompensa like Inngest or Trigger.dev?**

Inngest and Trigger.dev are **hosted** durable workflow platforms — you write functions, they run them on their infrastructure. kompensa runs **inside your own process**:

| | kompensa | Inngest / Trigger.dev |
| --- | --- | --- |
| Where it runs | your Node.js service | their hosted runtime |
| Deps on a third party | none | yes (their cloud) |
| Works offline / React Native | ✅ | ❌ |
| Hosted UI / observability | bring your own (hooks → OTel/Datadog/etc.) | included |
| Pricing | MIT-licensed library | per-execution pricing |

Pick a hosted platform if you want zero-ops durability and you're happy depending on a vendor. Pick kompensa if you want to keep workflows in your own process, avoid vendor lock-in, or run in environments the hosted platforms don't support.

---

## kompensa vs Effect's saga modules

**Q: I'm an Effect user — should I still use kompensa?**

Probably not. Effect already gives you typed retry, compensation primitives, and structured concurrency. kompensa is for teams **not** invested in a runtime like Effect, who want a small ergonomic library that drops into a regular Express / Fastify / NestJS / Next.js / BullMQ codebase.

---

## kompensa vs hand-rolled try/catch

**Q: Can I just write try/catch and a few flags?**

For 1–2 steps, yes. From 3 steps onwards, the failure matrix explodes:

- "Step 2 failed → run step-1 compensation."
- "Step 3 failed → run step-2 then step-1 compensation."
- "Compensation 1 failed during rollback of step-3 failure → don't lose the original error."
- "Process crashed mid-step-2 → don't run step-1 again."
- "Caller retried → don't run anything if we already succeeded."

That is exactly what kompensa does for you in a 20 KB package with **zero runtime dependencies**.

---

## When to **not** use kompensa

Be honest:

- **Single-step operation** with no rollback. Just call your function.
- **You already operate Temporal** and want consistency across services.
- **Workflow needs to last for days** with human approvals and external signals.
- **You need a hosted UI / observability** for non-engineers and don't want to build it. Use Inngest or Trigger.dev.

---

## See also

- [README](../README.md) — landing page with full feature matrix.
- [docs/concepts.md](./concepts.md) — state machine, lock protocol, retry semantics.
- [docs/faq.md](./faq.md) — top developer questions, pure Q&A.
- [llms.txt](../llms.txt) — short canonical summary for LLMs.
- [llms-full.txt](../llms-full.txt) — full LLM-ingestible reference.
