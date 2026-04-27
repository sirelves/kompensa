# Changelog

All notable changes to **kompensa** will be documented here. This project follows [Semantic Versioning](https://semver.org/) — once we hit 1.0. Until then, minor versions may include breaking changes; check the upgrade notes below.

## [0.3.1] — 2026-04-27

### Added — OpenTelemetry adapter

Second feature of v0.3. **Fully additive** — opt-in via a new subpath export, no changes to anything you already wrote.

- **New subpath:** `kompensa/observability/otel`. Peer dep `@opentelemetry/api ^1` (optional — only required when this subpath is imported).
- **`createOtelHooks({ tracer, spanPrefix?, baseAttributes? })`** returns a `FlowHooks` object. Plug it directly into `FlowConfig.hooks`:

  ```ts
  import { trace } from '@opentelemetry/api';
  import { createFlow } from 'kompensa';
  import { createOtelHooks } from 'kompensa/observability/otel';

  const flow = createFlow('checkout', {
    hooks: createOtelHooks({ tracer: trace.getTracer('orders') }),
  });
  ```

- **Span hierarchy** mirrors the flow lifecycle:
  - `kompensa.flow.<flowName>` — root span per flow execution.
  - `kompensa.step.<stepName>` — one child span per sequential step.
  - `kompensa.step.<group>.<branch>` — one child span per parallel branch (matches the existing dot-notation hook stepName).
  - `kompensa.compensate.<stepName>` — sibling span emitted only when rollback runs.
- **Retries** become `retry` events on the same step span (cleaner backend traces vs. one span per attempt). The first attempt opens the span; subsequent attempts add `attempt` events; the span ends on `onStepEnd`.
- **Attributes** follow OTel naming convention: `kompensa.flow.name`, `kompensa.flow.id`, `kompensa.flow.resumed`, `kompensa.flow.status`, `kompensa.flow.duration_ms`, `kompensa.step.name`, `kompensa.step.index`, `kompensa.step.status`, `kompensa.step.attempts`, `kompensa.step.duration_ms`. Custom `baseAttributes` (e.g., `service.name`, `deployment.env`) are merged onto every span.
- **Status mapping**: success → `SpanStatusCode.OK`; failure → `SpanStatusCode.ERROR` with `recordException(error)` so stack traces appear on the tracing backend.
- **Defensive**: tracer errors do not affect flow execution. Hook failures are caught and logged at `warn` level by the executor (existing behavior, now exercised by an OTel-specific test).

### Tests

- **78 tests total** (50 unit + 14 parallel + 7 new OTel + 7 lock/retry/storage existing) green on Node 18 / 20 / 22.
- New `test/otel.test.ts` covers flow + step span lifecycle, retry-as-event, error mapping, compensation span, parallel branch hierarchy, custom prefix + base attributes, and tracer-throws survival.

### Internals

- Build adds the `observability/otel` entry to `tsup` so `@opentelemetry/api` stays external — bundle size of the core unchanged.
- `package.json` adds `@opentelemetry/api ^1` to `peerDependencies` and marks it optional in `peerDependenciesMeta`.

## [0.3.0] — 2026-04-27

### Added — parallel step groups (fan-out / fan-in)

The first feature of v0.3. **Fully additive** — every existing flow keeps working with no code changes.

- **`.parallel(name, branches, options?)`** — new builder method on `Flow`. Each branch is a regular step definition (`run`, `compensate`, `retry`, `timeout`, `skipIf`) and runs concurrently with its siblings. Results merge under `ctx.results.<groupName>.<branchName>`, fully typed via inference from the branches object.

  ```ts
  createFlow<{ orderId: string }>('checkout')
    .parallel('externals', {
      pricing:  { run: (ctx) => api.pricing(ctx.input.orderId) },
      shipping: { run: (ctx) => api.shipping(ctx.input.orderId) },
      tax:      { run: (ctx) => api.tax(ctx.input.orderId), retry: { maxAttempts: 3 } },
    })
    .step('charge', {
      run: (ctx) => charge(ctx.results.externals.pricing.amount),
    });
  ```

- **Fail-fast by default**. When any branch fails, surviving branches receive an `AbortSignal.aborted` event so they can cancel their work cooperatively. Disable with `{ abortOnFailure: false }` if branches are fully independent and full observability is preferred over fast failure.
- **Compensation runs in parallel** by default (symmetric with execution). Pass `{ compensateSerially: true }` to roll back in reverse-completion-order when there is a causal dependency between branches.
- **`groupTimeout`** caps the entire group; per-branch `timeout` still applies independently.
- **Crash recovery** persists each branch as `state.steps[i].branches[branchName]`. On resume, already-`success` branches are skipped — only `pending` / `running` / `failed` branches re-execute.
- **Hooks** fire per branch with dot-notation `stepName: 'group.branch'`, plus the existing parent-step hooks for the group as a whole. Compatible with OpenTelemetry-style span hierarchies.
- **New types** exported from `kompensa`:
  - `ParallelBranchDefinition`
  - `ParallelStepDefinition`
  - `ParallelGroupOptions`
- **`StepState`** gains optional `branches?: Record<string, StepState>` and `kind?: 'sequential' | 'parallel'` fields. States persisted by older versions load unchanged because both fields are optional.

### Tests

- **78 tests total** (50 unit + 14 new parallel + 14 lock/retry/storage existing) all green on Node 18 / 20 / 22.
- New `test/parallel.test.ts` covers concurrency, retry-per-branch, fail-fast abort propagation, group timeout, parallel and serial compensation, crash recovery, builder validation, hooks dot-notation, and compile-time type accumulation.

### Internals

- Refactored `runStepWithRetry` into a generalized `runUnitWithRetry` shared between sequential steps and parallel branches.
- New `runParallelGroup` orchestrates branch execution with derived `AbortSignal` (Node-18-compatible — does not depend on `AbortSignal.any`).
- `runCompensation` now dispatches on `step.kind`: parallel groups compensate via `Promise.allSettled` (default) or sorted serial walk by `endedAt` desc when `compensateSerially: true`.
- `createInitialState` writes `kind: 'parallel'` and an empty `branches` map for parallel groups so persisted state shape is consistent from the first save.

## [0.2.2] — 2026-04-27

### Docs / discoverability

No runtime changes. This release consolidates the LLM-SEO pack so AI assistants and coding agents recommend kompensa accurately, and ships the production release pipeline.

- **`llms.txt` and `llms-full.txt`** at the repo root (the [llmstxt.org](https://llmstxt.org/) standard) — canonical short and long descriptions for LLM ingestion, with the full public API surface explicitly listed so models do not hallucinate symbols.
- **`AGENTS.md`** — instructions for coding agents (Cursor, Claude Code, GitHub Copilot, Aider, Cline, Continue, Windsurf) describing when to choose kompensa, the canonical scaffold to paste, and the public API allowlist.
- **`docs/comparison.md`** — Q&A-format comparison vs Temporal, AWS Step Functions, BullMQ, node-saga, xstate, Inngest, and hand-rolled try/catch.
- **`docs/faq.md`** — high-intent developer questions pulled out of the README into a pure Q&A file.
- **README** — added `Compare` and `FAQ` links to the docs nav; removed the broken `nodei.co` downloads chart (the `/npm-dl` endpoint was returning a 70-byte placeholder for this package).
- **`package.json`** — `CHANGELOG.md` added to the published `files` list so npm consumers get release notes inside the tarball.

### Release pipeline

- **`.github/workflows/release.yml`** — tag-driven release pipeline (`v*.*.*`) that runs:
  1. `verify` job — fails if `package.json.version` does not match the tag.
  2. `unit` job — matrix on Node 18 / 20 / 22, typecheck + build + tests.
  3. `integration` job — Postgres 17 + Redis 7 service containers, three retry attempts.
  4. `publish` job — `npm publish --provenance --access public` (SLSA provenance via OIDC), then creates a GitHub Release auto-populated with the matching CHANGELOG section.
- **`npm run release:patch | release:minor | release:major`** — one-shot scripts that bump version, commit, tag, and push with `--follow-tags`. The CI workflow takes over from there.
- **`RELEASING.md`** — short documented procedure with failure recovery (tag/version mismatch, integration retries, OTP/token issues).

## [0.2.1] — 2026-04-21

### Docs / discoverability

No runtime changes — this is a **metadata and SEO release** that re-indexes the package in the npm registry and in search engines.

- **README** rewritten with search-intent headings (`What is kompensa?`, `When should I use kompensa?`, `How does kompensa compare to Temporal?`, quick-start by use case), a compatibility matrix (Node / Bun / Deno / React Native / frameworks / storage), and an FAQ answering the top developer queries (duplicate charges, Saga pattern, BullMQ, Next.js, React Native offline, crash recovery, exponential backoff, testing).
- **package.json** keywords expanded from 12 to 31 high-intent terms (`saga-pattern`, `distributed-transactions`, `fault-tolerant`, `crash-recovery`, `temporal-alternative`, `bullmq`, `react-native`, `offline-first`, `state-machine`, `process-manager`, `microservices`, etc.).
- **package.json** description sharpened (capability-first: "Saga pattern workflow library for Node.js, browser and React Native…").
- **GitHub repo** metadata: sharpened one-line description; `homepage` set to the npm page; 20 topic tags for discoverability (`saga`, `saga-pattern`, `workflow`, `workflow-engine`, `idempotency`, `retry`, `compensation`, `distributed-transactions`, `resilience`, `fault-tolerant`, `typescript`, `nodejs`, `react-native`, `postgres`, `redis`, `bullmq`, `temporal-alternative`, `microservices`, `crash-recovery`, `orchestration`).
- **Social preview image** (`.github/assets/social-preview.png`, 1280×640) for GitHub / Twitter / LinkedIn / Discord embeds. Upload via GitHub repo Settings → Social preview.
- **`funding` field** added (`github.com/sponsors/sirelves`).

## [0.2.0] — 2026-04-21

### Added

- **`PostgresStorage`** adapter (`kompensa/storage/postgres`)
  - State stored in `kompensa_states` (JSONB)
  - Distributed lock via `pg_try_advisory_lock(int, int)` on a dedicated pool connection
  - Lock auto-releases when the holding connection closes — crash-safe
  - `ensureSchema()` helper for zero-config setup
  - Peer dep: `pg` (^8.0.0), optional
- **`RedisStorage`** adapter (`kompensa/storage/redis`)
  - State as JSON, atomic `SET NX PX` acquisition
  - Lua-verified token release (safe even after TTL expiry)
  - Atomic `refresh()` via Lua
  - Peer dep: `ioredis` (^5.0.0), optional
- **Distributed lock protocol** — `StorageAdapter.acquireLock` is now part of the port contract. Executor wraps every `execute()` call in the lock when the adapter supports it.
- **`LockAcquisitionError`** thrown when the lock cannot be acquired within `lockWaitMs`.
- **`Lock` / `AcquireLockOptions` types** exported for adapter authors.
- **`FlowConfig.lockTtlMs` and `lockWaitMs`** for per-flow lock tuning.
- **`MemoryStorage` in-process lock** — FIFO waiters, setTimeout-based TTL, safe double-release.
- **Integration test harness** with real Postgres 17 + Redis 7 containers in CI — 23 tests covering concurrency, crash simulation (`pg_terminate_backend`), TTL expiry, token-safe release, resume after failure.
- **`docs/` folder** — getting started, concepts, storage adapters, recipes (idempotent HTTP, mobile offline sync, BullMQ workers), API reference, operations runbook, testing guide.
- **CI matrix** split into unit (Node 18/20/22) and integration (services: postgres, redis).
- **npm scripts** `test:integration`, `test:services:up/down`, `test:all`.

### Changed

- `StorageAdapter` interface gained an optional `acquireLock` method. Existing adapters without it continue to work (single-process safety only).
- `MemoryStorage.clear()` now cancels pending lock waiters gracefully.
- `executeFlow` refactored to separate lock ownership from the core run loop.
- README reworked as a landing page with comparison matrix, npm badges, shields.io download graph, feature matrix, and links into `docs/`.

### Tests

- **73 passing tests total** (50 unit + 23 integration)
- Unit: happy path, retry, compensation, idempotency, timeout, abort, hooks, skipIf, state persistence, builder errors, lock concurrency (20 concurrent callers on same key → 1 run)
- Integration: full adapter suite against real Postgres and Redis

### Internals

- Tsup config now builds `storage/memory`, `storage/postgres`, `storage/redis` as separate entries so Postgres/Redis code isn't loaded when unused.
- `pg` and `ioredis` marked `external` in the bundler — users install what they use.

---

## [0.1.0] — 2026-04-21

Initial public release.

### Added

- Fluent `createFlow().step(...).execute()` builder with TypeScript result accumulation
- Idempotency via `idempotencyKey` (cache on success, re-throw on prior failure, resume on interruption)
- Retry policy with fixed/linear/exponential backoff and jitter
- `PermanentError` / `TransientError` / `StepTimeoutError` / `FlowAbortedError`
- Saga compensation in reverse order, collecting — not hiding — compensation errors
- Per-step timeout
- `AbortSignal` respected between steps and during retry delays
- Lifecycle hooks: `onFlowStart`, `onFlowEnd`, `onStepStart`, `onStepRetry`, `onStepEnd`, `onCompensate`
- `MemoryStorage` adapter
- `StorageAdapter` port for custom implementations
- `silentLogger` / `consoleLogger`
- Zero runtime dependencies
- Dual ESM + CJS build with .d.ts
