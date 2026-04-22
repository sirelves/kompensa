import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { createFlow, LockAcquisitionError } from '../../src/index.js';
import { RedisStorage } from '../../src/storage/redis.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6381';

const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
const storage = new RedisStorage({ client });

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.quit();
});

beforeEach(async () => {
  const keys = await client.keys('flowguard:*');
  if (keys.length > 0) await client.del(...keys);
});

describe('RedisStorage — state persistence', () => {
  it('saves and loads state', async () => {
    const flow = createFlow<{ x: number }>('rd-basic', { storage })
      .step('a', { run: (c) => c.input.x + 1 })
      .step('b', { run: (c) => c.results.a * 2 });

    const result = await flow.execute({ x: 5 }, { idempotencyKey: 'k1' });
    expect(result).toEqual({ a: 6, b: 12 });

    const loaded = await storage.load('rd-basic', 'k1');
    expect(loaded?.status).toBe('success');
    expect(loaded?.result).toEqual({ a: 6, b: 12 });
  });

  it('idempotent replay returns cached result', async () => {
    let runs = 0;
    const flow = createFlow<{}>('rd-idem', { storage }).step('once', {
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
    const flow = createFlow<{}>('rd-fail', { storage })
      .step('a', { run: () => 'A', compensate: () => {} })
      .step('b', {
        run: () => {
          throw new Error('boom');
        },
      });

    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toThrow();

    const loaded = await storage.load('rd-fail', 'k');
    expect(loaded?.status).toBe('compensated');
    expect(loaded?.steps[0]?.status).toBe('compensated');
    expect(loaded?.steps[1]?.status).toBe('failed');
  });
});

describe('RedisStorage — distributed lock', () => {
  it('serializes concurrent executions on same idempotencyKey', async () => {
    let runs = 0;
    let active = 0;
    let maxActive = 0;

    const flow = createFlow<{}>('rd-lock', { storage }).step('work', {
      run: async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
        return 'ok';
      },
    });

    await Promise.all(
      Array.from({ length: 10 }, () => flow.execute({}, { idempotencyKey: 'shared' })),
    );

    expect(runs).toBe(1);
    expect(maxActive).toBe(1);
  });

  it('allows concurrent execution across different keys', async () => {
    let active = 0;
    let maxActive = 0;

    const flow = createFlow<{}>('rd-parallel', { storage }).step('work', {
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
    const holder = await storage.acquireLock('rd-x', 'id-1', {
      ttlMs: 60_000,
      timeoutMs: 0,
    });

    try {
      await expect(
        storage.acquireLock('rd-x', 'id-1', { ttlMs: 60_000, timeoutMs: 0 }),
      ).rejects.toBeInstanceOf(LockAcquisitionError);
    } finally {
      await holder.release();
    }
  });

  it('wait timeout is honored', async () => {
    const holder = await storage.acquireLock('rd-y', 'id-1', {
      ttlMs: 60_000,
      timeoutMs: 0,
    });

    try {
      const start = Date.now();
      await expect(
        storage.acquireLock('rd-y', 'id-1', { ttlMs: 60_000, timeoutMs: 150 }),
      ).rejects.toBeInstanceOf(LockAcquisitionError);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(500);
    } finally {
      await holder.release();
    }
  });

  it('lock TTL expires automatically', async () => {
    const holder = await storage.acquireLock('rd-ttl', 'id', {
      ttlMs: 100,
      timeoutMs: 0,
    });

    // Before TTL expires — second attempt fails fast
    await expect(
      storage.acquireLock('rd-ttl', 'id', { ttlMs: 60_000, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(LockAcquisitionError);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 150));

    // Now acquirable
    const fresh = await storage.acquireLock('rd-ttl', 'id', {
      ttlMs: 60_000,
      timeoutMs: 0,
    });
    await fresh.release();

    // Releasing the original lock after TTL expired must be safe — token
    // mismatch via the Lua script means it's a no-op.
    await expect(holder.release()).resolves.not.toThrow();
  });

  it('release only deletes the lock if token matches', async () => {
    const a = await storage.acquireLock('rd-token', 'id', {
      ttlMs: 50,
      timeoutMs: 0,
    });

    await new Promise((r) => setTimeout(r, 100)); // TTL expired, lock gone

    // Another party acquires the lock with a different token
    const b = await storage.acquireLock('rd-token', 'id', {
      ttlMs: 60_000,
      timeoutMs: 0,
    });

    // First holder's release MUST NOT delete the second holder's lock
    await a.release();

    // Verify b is still held
    await expect(
      storage.acquireLock('rd-token', 'id', { ttlMs: 60_000, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(LockAcquisitionError);

    await b.release();
  });

  it('refresh extends the lock TTL', async () => {
    const lock = await storage.acquireLock('rd-refresh', 'id', {
      ttlMs: 100,
      timeoutMs: 0,
    });

    await new Promise((r) => setTimeout(r, 60));
    await lock.refresh!();
    await new Promise((r) => setTimeout(r, 60));

    // 120ms passed; TTL was refreshed at 60ms → still held
    await expect(
      storage.acquireLock('rd-refresh', 'id', { ttlMs: 60_000, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(LockAcquisitionError);

    await lock.release();
  });

  it('lock releases after execution completes', async () => {
    const flow = createFlow<{}>('rd-release', { storage }).step('ok', { run: () => 'ok' });
    await flow.execute({}, { idempotencyKey: 'k' });

    const lock = await storage.acquireLock('rd-release', 'k', {
      ttlMs: 1000,
      timeoutMs: 0,
    });
    await lock.release();
  });

  it('lock releases after execution fails', async () => {
    const flow = createFlow<{}>('rd-release-fail', { storage }).step('bad', {
      run: () => {
        throw new Error('fail');
      },
    });

    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toThrow();

    const lock = await storage.acquireLock('rd-release-fail', 'k', {
      ttlMs: 1000,
      timeoutMs: 0,
    });
    await lock.release();
  });
});
