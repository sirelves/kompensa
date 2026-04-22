# Storage adapters

Storage is the only required port. It's what makes kompensa durable, idempotent, and multi-worker-safe.

## Which adapter?

| Need | Use |
| --- | --- |
| Unit tests, single-process scripts, mobile/browser (no crash-safety) | `MemoryStorage` |
| Backend service, already using Postgres | `PostgresStorage` |
| Backend service, already using Redis | `RedisStorage` |
| Mobile/RN with durable local queue | Custom adapter over SQLite/MMKV |
| Edge runtime / serverless | Custom adapter over KV store |

**Rule of thumb:** use the datastore you already operate. kompensa's state is small (a JSONB row per active flow) — it doesn't need its own infrastructure.

## `MemoryStorage`

The default. Zero setup, zero deps.

```ts
import { createFlow, MemoryStorage } from 'kompensa';

const storage = new MemoryStorage();
const flow = createFlow('x', { storage }).step(/* ... */);
```

**Supports:** load, save, delete, in-process locking with FIFO waiters and TTL.
**Doesn't support:** cross-process locking. Two Node processes with separate `MemoryStorage` instances will not serialize on the same key.
**Persistence:** none — state evaporates when the process exits.

## `PostgresStorage`

```ts
import { Pool } from 'pg';
import { PostgresStorage } from 'kompensa/storage/postgres';

const storage = new PostgresStorage({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
});

await storage.ensureSchema();  // one-time table creation
```

**Requires:** `pg` as a peer dependency. Install with `npm install pg`.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS kompensa_states (
  flow_name  TEXT NOT NULL,
  flow_id    TEXT NOT NULL,
  state      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (flow_name, flow_id)
);
CREATE INDEX kompensa_states_updated_idx ON kompensa_states (updated_at);
```

Call `ensureSchema()` at startup, or generate a migration via your tool of choice using the SQL above.

**Locking:** uses `pg_try_advisory_lock(hashtext(namespace), hashtext(key))` on a dedicated pool connection. Lock auto-releases when the connection closes, which happens on worker crash — no need for explicit cleanup after failures.

**Pool sizing:** each concurrent `execute()` call holds one connection for the lock's duration plus transient connections for state queries. Size the pool for `max_concurrent_flows × 2` at minimum.

**Options:**

```ts
new PostgresStorage({
  pool,
  tableName: 'kompensa_states',      // default
  lockNamespace: 'kompensa',          // default — prevents collision with other advisory locks
  lockPollMs: 50,                      // polling interval while waiting
});
```

## `RedisStorage`

```ts
import Redis from 'ioredis';
import { RedisStorage } from 'kompensa/storage/redis';

const storage = new RedisStorage({
  client: new Redis(process.env.REDIS_URL),
});
```

**Requires:** `ioredis` as a peer dependency. Install with `npm install ioredis`.

**Keys written:**

- `kompensa:state:{flowName}:{flowId}` — JSON-serialized state
- `kompensa:lock:{flowName}:{flowId}` — random token, with `PX` TTL, `NX` guarded

**Locking:** Redlock-style single-node. `SET NX PX` for acquisition, Lua script for token-safe release (so a process whose TTL expired cannot delete another holder's lock).

**Trade-off vs Postgres:** Redis has native lock TTL (enforced server-side), Postgres does not. Redis is ~10x faster for the lock itself. Postgres gives you one fewer service to run if you already have a database. Both are production-safe for kompensa's use case.

**Options:**

```ts
new RedisStorage({
  client,
  keyPrefix: 'kompensa',   // default
  lockPollMs: 50,           // polling interval while waiting
});
```

**Multi-node Redlock:** not implemented. kompensa's single-node Redlock is correct for a single Redis master. For a Redis cluster with multiple masters, use Postgres or wait for `kompensa-redlock` (planned v0.3).

## Writing your own adapter

The interface is three required methods plus an optional lock:

```ts
import type { StorageAdapter, FlowState, AcquireLockOptions, Lock } from 'kompensa';

export class MyStorage implements StorageAdapter {
  async load(flowName: string, flowId: string): Promise<FlowState | null> {
    // SELECT ... FROM my_store WHERE (flow_name, flow_id) = ($1, $2)
  }

  async save(state: FlowState): Promise<void> {
    // UPSERT flow_state keyed on (flow_name, flow_id)
  }

  async delete(flowName: string, flowId: string): Promise<void> {
    // DELETE FROM my_store WHERE ...
  }

  // Optional — but strongly recommended if multiple workers call this adapter
  async acquireLock(
    flowName: string,
    flowId: string,
    options: AcquireLockOptions,
  ): Promise<Lock> {
    // Acquire an exclusive lock. Must block (up to options.timeoutMs) or fail
    // fast with LockAcquisitionError.
    // Return a Lock with .release() (required) and .refresh() (optional).
  }
}
```

### Minimal SQLite adapter for mobile

```ts
import type { StorageAdapter, FlowState } from 'kompensa';

export class SqliteStorage implements StorageAdapter {
  constructor(private readonly db: SQLiteDatabase) {
    db.execAsync(`
      CREATE TABLE IF NOT EXISTS kompensa_states (
        flow_name TEXT NOT NULL,
        flow_id   TEXT NOT NULL,
        state     TEXT NOT NULL,
        PRIMARY KEY (flow_name, flow_id)
      )
    `);
  }

  async load(flowName: string, flowId: string): Promise<FlowState | null> {
    const row = await this.db.getFirstAsync<{ state: string }>(
      'SELECT state FROM kompensa_states WHERE flow_name = ? AND flow_id = ?',
      [flowName, flowId],
    );
    return row ? JSON.parse(row.state) : null;
  }

  async save(state: FlowState): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO kompensa_states (flow_name, flow_id, state)
       VALUES (?, ?, ?)
       ON CONFLICT (flow_name, flow_id) DO UPDATE SET state = excluded.state`,
      [state.flowName, state.flowId, JSON.stringify(state)],
    );
  }

  async delete(flowName: string, flowId: string): Promise<void> {
    await this.db.runAsync(
      'DELETE FROM kompensa_states WHERE flow_name = ? AND flow_id = ?',
      [flowName, flowId],
    );
  }

  // No acquireLock — mobile apps have a single process per user.
}
```

### Guarantees an adapter MUST provide

1. **Atomic save.** Partial writes corrupt the state machine. Use transactions or KV guarantees.
2. **Linearizable read-after-write.** `save(s)` followed by `load(s.flowName, s.flowId)` must return `s`.
3. **Lock mutual exclusion.** If you implement `acquireLock`, only one caller may hold the lock per `(flowName, flowId)` at a time. Redlock or advisory locks are the blessed patterns.
4. **Lock release on crash.** The adapter must have a mechanism (TTL, connection-bound, heartbeat) that releases stale locks. Otherwise one crashed worker deadlocks the key forever.

### Guarantees an adapter MAY skip

- **Global ordering** — kompensa doesn't need cross-key consistency.
- **Secondary indexes** — the state is always looked up by `(flowName, flowId)`.
- **Eviction / cleanup** — kompensa never deletes its own state unless you call `storage.delete()`. Add a janitor job if your long-term state growth matters.
