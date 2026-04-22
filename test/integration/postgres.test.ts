import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createFlow, LockAcquisitionError, TransientError } from '../../src/index.js';
import { PostgresStorage } from '../../src/storage/postgres.js';

const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  'postgres://flowguard:flowguard@localhost:5434/flowguard_test';

// Generous pool — each concurrent execute() holds one client for the lock
// plus transient clients for state queries. Set max well above the concurrency
// used by these tests to avoid starvation-induced deadlocks.
const pool = new Pool({ connectionString: POSTGRES_URL, max: 30 });
const storage = new PostgresStorage({ pool });

// The crash-simulation test terminates a backend via pg_terminate_backend,
// which causes the killed connection to emit an async 'error' event (57P01).
// Swallow those at the pool level — production apps should do the same.
pool.on('error', (err) => {
  const code = (err as { code?: string }).code;
  if (code === '57P01' || code === 'ECONNRESET') return;
  // Any other pool error is worth seeing.
  // eslint-disable-next-line no-console
  console.error('unexpected pool error:', err);
});

beforeAll(async () => {
  await storage.ensureSchema();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE flowguard_states');
});

describe('PostgresStorage — state persistence', () => {
  it('saves and loads state', async () => {
    const flow = createFlow<{ x: number }>('pg-basic', { storage })
      .step('a', { run: (c) => c.input.x + 1 })
      .step('b', { run: (c) => c.results.a * 2 });

    const result = await flow.execute({ x: 5 }, { idempotencyKey: 'k1' });
    expect(result).toEqual({ a: 6, b: 12 });

    const loaded = await storage.load('pg-basic', 'k1');
    expect(loaded?.status).toBe('success');
    expect(loaded?.result).toEqual({ a: 6, b: 12 });
  });

  it('idempotent replay returns cached result', async () => {
    let runs = 0;
    const flow = createFlow<{}>('pg-idem', { storage }).step('once', {
      run: () => {
        runs++;
        return 'done';
      },
    });

    await flow.execute({}, { idempotencyKey: 'k' });
    await flow.execute({}, { idempotencyKey: 'k' });

    expect(runs).toBe(1);
  });

  it('persists compensated state after failure', async () => {
    const flow = createFlow<{}>('pg-fail', { storage })
      .step('a', { run: () => 'A', compensate: () => {} })
      .step('b', {
        run: () => {
          throw new Error('boom');
        },
      });

    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toThrow();

    const loaded = await storage.load('pg-fail', 'k');
    expect(loaded?.status).toBe('compensated');
    expect(loaded?.steps[0]?.status).toBe('compensated');
    expect(loaded?.steps[1]?.status).toBe('failed');
  });
});

describe('PostgresStorage — distributed lock', () => {
  it('serializes concurrent executions on same idempotencyKey', async () => {
    let runs = 0;
    let active = 0;
    let maxActive = 0;

    const flow = createFlow<{}>('pg-lock', { storage }).step('work', {
      run: async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
        return 'ok';
      },
    });

    // 10 concurrent executions, same key
    await Promise.all(
      Array.from({ length: 10 }, () => flow.execute({}, { idempotencyKey: 'shared' })),
    );

    expect(runs).toBe(1);
    expect(maxActive).toBe(1);
  });

  it('allows concurrent execution across different keys', async () => {
    let active = 0;
    let maxActive = 0;

    const flow = createFlow<{}>('pg-parallel', { storage }).step('work', {
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return 'ok';
      },
    });

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        flow.execute({}, { idempotencyKey: `key-${i}` }),
      ),
    );

    expect(maxActive).toBeGreaterThan(1);
  });

  it('fails fast with lockWaitMs: 0 when lock is held', async () => {
    const holder = new PostgresStorage({ pool });
    const lock = await holder.acquireLock('flow-x', 'id-1', {
      ttlMs: 60_000,
      timeoutMs: 0,
    });

    try {
      await expect(
        storage.acquireLock('flow-x', 'id-1', { ttlMs: 60_000, timeoutMs: 0 }),
      ).rejects.toBeInstanceOf(LockAcquisitionError);
    } finally {
      await lock.release();
    }
  });

  it('wait timeout is honored', async () => {
    const holder = await storage.acquireLock('flow-y', 'id-1', {
      ttlMs: 60_000,
      timeoutMs: 0,
    });

    try {
      const start = Date.now();
      await expect(
        storage.acquireLock('flow-y', 'id-1', { ttlMs: 60_000, timeoutMs: 150 }),
      ).rejects.toBeInstanceOf(LockAcquisitionError);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(500);
    } finally {
      await holder.release();
    }
  });

  it('lock releases after execution completes (success)', async () => {
    const flow = createFlow<{}>('pg-release', { storage }).step('ok', { run: () => 'ok' });
    await flow.execute({}, { idempotencyKey: 'k' });

    // Should be acquirable again immediately
    const lock = await storage.acquireLock('pg-release', 'k', {
      ttlMs: 1000,
      timeoutMs: 0,
    });
    await lock.release();
  });

  it('lock releases after execution fails', async () => {
    const flow = createFlow<{}>('pg-release-fail', { storage }).step('bad', {
      run: () => {
        throw new Error('fail');
      },
    });

    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toThrow();

    // Lock must be released even after failure
    const lock = await storage.acquireLock('pg-release-fail', 'k', {
      ttlMs: 1000,
      timeoutMs: 0,
    });
    await lock.release();
  });

  it('lock releases when holding backend is killed (crash simulation)', async () => {
    // Use a dedicated pool so we can kill its only connection without
    // affecting the main test pool.
    const doomedPool = new Pool({ connectionString: POSTGRES_URL, max: 1 });
    // Suppress the expected async 57P01 error when the backend is terminated.
    doomedPool.on('error', () => {});

    const crasher = await doomedPool.connect();
    // Also suppress on the client itself — pg emits 'error' on the Client
    // object before the pool observes the dropped connection.
    crasher.on('error', () => {});

    const pidRes = await crasher.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = pidRes.rows[0]!.pid;

    await crasher.query(
      'SELECT pg_advisory_lock(hashtext($1), hashtext($2))',
      ['flowguard', 'pg-crash:id'],
    );

    // Confirm the lock is held — storage must fail fast to acquire.
    await expect(
      storage.acquireLock('pg-crash', 'id', { ttlMs: 60_000, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(LockAcquisitionError);

    // Kill the holder's backend from a separate connection — this is what
    // happens when a worker crashes. Postgres releases the session's locks.
    await pool.query('SELECT pg_terminate_backend($1)', [pid]);

    // Give the socket error a tick to propagate and be swallowed.
    await new Promise((r) => setTimeout(r, 50));

    // Main pool can now acquire the lock.
    const fresh = await storage.acquireLock('pg-crash', 'id', {
      ttlMs: 60_000,
      timeoutMs: 3000,
    });
    await fresh.release();

    // Clean up the doomed pool; its single client is already dead.
    try {
      crasher.release(new Error('crashed'));
    } catch {
      /* ignore */
    }
    await doomedPool.end().catch(() => {});
  });
});

describe('PostgresStorage — resume after crash', () => {
  it('resumes from the first incomplete step on re-execute', async () => {
    const runs: string[] = [];
    let fail = true;

    const build = () =>
      createFlow<{}>('pg-resume', { storage })
        .step('a', {
          run: () => {
            runs.push('a');
            return 'A';
          },
        })
        .step('b', {
          run: () => {
            runs.push('b');
            if (fail) throw new TransientError('sim crash');
            return 'B';
          },
        });

    // First execution dies at b and is marked compensated
    await expect(build().execute({}, { idempotencyKey: 'r' })).rejects.toThrow();

    // Simulate a crash rather than a final failure: reset the state to
    // 'running' with step b pending, as if the process crashed mid-step.
    const state = await storage.load('pg-resume', 'r');
    expect(state).not.toBeNull();
    state!.status = 'running';
    state!.steps[1]!.status = 'pending';
    state!.steps[1]!.attempts = 0;
    delete state!.steps[1]!.error;
    state!.steps[0]!.status = 'success';
    await storage.save(state!);

    fail = false;
    runs.length = 0;
    const result = await build().execute({}, { idempotencyKey: 'r' });
    expect(result).toEqual({ a: 'A', b: 'B' });
    expect(runs).toEqual(['b']); // 'a' was skipped on resume
  });
});
