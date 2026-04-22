import type { AcquireLockOptions, FlowState, Lock, StorageAdapter } from '../types.js';
import { LockAcquisitionError } from '../errors.js';
import { sleep } from '../utils/sleep.js';

/**
 * Structural subset of `pg.Pool` — we only need `query` and `connect`.
 * Import `Pool` from `pg` and pass an instance; avoids a hard dep on `pg`.
 */
export interface PgPoolLike {
  query<R = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
  connect(): Promise<PgClientLike>;
}

export interface PgClientLike {
  query<R = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
  release(err?: unknown): void;
}

export interface PostgresStorageOptions {
  pool: PgPoolLike;
  /** Table name for flow state. Default: `kompensa_states`. */
  tableName?: string;
  /**
   * Identifier used to namespace Postgres advisory locks, avoiding collision
   * with locks used by other subsystems. Default: `kompensa`.
   */
  lockNamespace?: string;
  /** Polling interval while waiting for a contested lock, in ms. Default: 50. */
  lockPollMs?: number;
}

/**
 * Durable Postgres-backed storage. Uses JSONB for state and session-level
 * advisory locks for multi-worker safety.
 *
 * Locks automatically release when the holding connection closes — so worker
 * crashes don't permanently wedge an idempotency key. Advisory locks do not
 * have a server-side TTL; the `ttlMs` option is advisory only and ignored.
 *
 * @example
 * import { Pool } from 'pg';
 * import { PostgresStorage } from 'kompensa/storage/postgres';
 *
 * const storage = new PostgresStorage({
 *   pool: new Pool({ connectionString: process.env.DATABASE_URL }),
 * });
 * await storage.ensureSchema();
 *
 * const flow = createFlow('checkout', { storage }).step(...)
 */
export class PostgresStorage implements StorageAdapter {
  private readonly pool: PgPoolLike;
  private readonly tableName: string;
  private readonly lockNamespace: string;
  private readonly lockPollMs: number;

  constructor(opts: PostgresStorageOptions) {
    if (!opts.pool) {
      throw new Error('kompensa: PostgresStorage requires a `pool` option');
    }
    this.pool = opts.pool;
    this.tableName = opts.tableName ?? 'kompensa_states';
    this.lockNamespace = opts.lockNamespace ?? 'kompensa';
    this.lockPollMs = opts.lockPollMs ?? 50;

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.tableName)) {
      throw new Error(`kompensa: invalid tableName "${this.tableName}"`);
    }
  }

  async load(flowName: string, flowId: string): Promise<FlowState | null> {
    const { rows } = await this.pool.query<{ state: FlowState }>(
      `SELECT state FROM ${this.tableName} WHERE flow_name = $1 AND flow_id = $2`,
      [flowName, flowId],
    );
    return rows[0]?.state ?? null;
  }

  async save(state: FlowState): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.tableName} (flow_name, flow_id, state, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (flow_name, flow_id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [state.flowName, state.flowId, JSON.stringify(state)],
    );
  }

  async delete(flowName: string, flowId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE flow_name = $1 AND flow_id = $2`,
      [flowName, flowId],
    );
  }

  async acquireLock(
    flowName: string,
    flowId: string,
    options: AcquireLockOptions,
  ): Promise<Lock> {
    const { timeoutMs } = options;
    const client = await this.pool.connect();

    try {
      // Fast-path: try once without waiting.
      if (await this.tryLock(client, flowName, flowId)) {
        return this.makeLock(client, flowName, flowId);
      }

      if (timeoutMs <= 0) {
        throw new LockAcquisitionError(flowName, flowId, 'lock is held');
      }

      // Poll until acquired or timeout elapses.
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const remaining = timeoutMs - (Date.now() - start);
        await sleep(Math.min(this.lockPollMs, remaining));
        if (await this.tryLock(client, flowName, flowId)) {
          return this.makeLock(client, flowName, flowId);
        }
      }

      throw new LockAcquisitionError(
        flowName,
        flowId,
        `wait timeout after ${timeoutMs}ms`,
      );
    } catch (err) {
      client.release();
      throw err;
    }
  }

  private async tryLock(
    client: PgClientLike,
    flowName: string,
    flowId: string,
  ): Promise<boolean> {
    const { rows } = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok`,
      [this.lockNamespace, `${flowName}:${flowId}`],
    );
    return rows[0]?.ok === true;
  }

  private makeLock(client: PgClientLike, flowName: string, flowId: string): Lock {
    const namespace = this.lockNamespace;
    const key = `${flowName}:${flowId}`;
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        try {
          await client.query(
            `SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`,
            [namespace, key],
          );
        } finally {
          client.release();
        }
      },
      // Advisory locks have no server-side TTL — refresh is a no-op. If the
      // holder crashes, the connection dies and the lock auto-releases.
      async refresh() {
        /* no-op */
      },
    };
  }

  /**
   * Create the state table if it doesn't exist. Safe to call repeatedly.
   * Use this once at startup or migrate via your preferred migration tool
   * using the SQL in `kompensa/storage/postgres/schema.sql`.
   */
  async ensureSchema(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
         flow_name  TEXT NOT NULL,
         flow_id    TEXT NOT NULL,
         state      JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (flow_name, flow_id)
       )`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.tableName}_updated_idx
         ON ${this.tableName} (updated_at)`,
    );
  }
}

export function createPostgresStorage(opts: PostgresStorageOptions): PostgresStorage {
  return new PostgresStorage(opts);
}
