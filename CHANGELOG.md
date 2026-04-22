# Changelog

All notable changes to **kompensa** will be documented here. This project follows [Semantic Versioning](https://semver.org/) — once we hit 1.0. Until then, minor versions may include breaking changes; check the upgrade notes below.

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
