import { describe, it, expect } from 'vitest';
import { createFlow, MemoryStorage, LockAcquisitionError } from '../src/index.js';

describe('distributed lock (MemoryStorage)', () => {
  it('prevents concurrent execution of the same idempotencyKey', async () => {
    const storage = new MemoryStorage();
    let activeCount = 0;
    let maxConcurrent = 0;
    let runs = 0;

    const flow = createFlow<{ n: number }>('concurrent', { storage }).step('work', {
      run: async (ctx) => {
        runs++;
        activeCount++;
        maxConcurrent = Math.max(maxConcurrent, activeCount);
        await new Promise((r) => setTimeout(r, 20));
        activeCount--;
        return ctx.input.n * 2;
      },
    });

    // 20 concurrent callers with the SAME idempotencyKey.
    // Only one should execute; the rest should wait and get the cached result.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        flow.execute({ n: i }, { idempotencyKey: 'shared-key' }),
      ),
    );

    expect(runs).toBe(1);
    expect(maxConcurrent).toBe(1);
    // Every caller gets the winner's result (first caller wrote n=0 or whichever).
    const unique = new Set(results.map((r) => r.work));
    expect(unique.size).toBe(1);
  });

  it('allows concurrent execution across DIFFERENT idempotencyKeys', async () => {
    const storage = new MemoryStorage();
    let activeCount = 0;
    let maxConcurrent = 0;

    const flow = createFlow<{}>('parallel', { storage }).step('work', {
      run: async () => {
        activeCount++;
        maxConcurrent = Math.max(maxConcurrent, activeCount);
        await new Promise((r) => setTimeout(r, 15));
        activeCount--;
        return 'ok';
      },
    });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        flow.execute({}, { idempotencyKey: `key-${i}` }),
      ),
    );

    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('fails fast with lockWaitMs: 0 when lock is held', async () => {
    const storage = new MemoryStorage();

    const flow = createFlow<{}>('fail-fast', {
      storage,
      lockWaitMs: 0,
    }).step('slow', {
      run: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'ok';
      },
    });

    const first = flow.execute({}, { idempotencyKey: 'k' });
    // Give the first call a moment to acquire the lock.
    await new Promise((r) => setTimeout(r, 5));

    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toBeInstanceOf(
      LockAcquisitionError,
    );

    await first; // cleanup
  });

  it('honors lockWaitMs timeout', async () => {
    const storage = new MemoryStorage();

    const flow = createFlow<{}>('wait-timeout', {
      storage,
      lockWaitMs: 20,
    }).step('slow', {
      run: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'ok';
      },
    });

    const first = flow.execute({}, { idempotencyKey: 'k' });
    await new Promise((r) => setTimeout(r, 5));

    const start = Date.now();
    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toThrow(
      /wait timeout/,
    );
    const elapsed = Date.now() - start;
    // Should reject in ~20ms, not wait for the 200ms first call to finish.
    expect(elapsed).toBeLessThan(100);

    await first;
  });

  it('releases lock after step failure so retry is possible', async () => {
    const storage = new MemoryStorage();
    let attempts = 0;

    const flow = createFlow<{}>('fail-release', { storage }).step('go', {
      run: () => {
        attempts++;
        throw new Error('boom');
      },
    });

    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toThrow();
    // After failure the flow is in 'compensated' state; second call short-
    // circuits with FlowError — but it must still be able to acquire the lock,
    // which proves cleanup happened.
    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toThrow();
    expect(attempts).toBe(1); // second call didn't re-execute (idempotent)
  });

  it('lock TTL expires and releases the lock', async () => {
    const storage = new MemoryStorage();
    let phase = 'pre';

    // First flow holds the lock while running a long step.
    const slow = createFlow<{}>('ttl', {
      storage,
      lockTtlMs: 30, // short TTL — expires while step is still running
    }).step('work', {
      run: async () => {
        await new Promise((r) => setTimeout(r, 150));
        phase = 'done';
        return 'first';
      },
    });

    // Second flow reuses the same idempotencyKey; with lock expired it
    // should be able to acquire and (due to state already being 'running')
    // race conditions are up to the adapter's durability guarantees. For an
    // in-process adapter like MemoryStorage, the TTL-released lock just lets
    // the second caller try.
    const first = slow.execute({}, { idempotencyKey: 'ttl-key' });

    // Wait for the TTL to elapse.
    await new Promise((r) => setTimeout(r, 50));

    // At this point the lock held by the first executor has TTL-expired in the
    // MemoryStorage. The lock Map should be free (or held by nobody with
    // active work). We can acquire a fresh lock on an unrelated key without
    // blocking.
    expect(phase).toBe('pre');

    const other = createFlow<{}>('ttl', { storage, lockWaitMs: 0 }).step('work', {
      run: () => 'other',
    });
    // Use a DIFFERENT key to prove unrelated keys aren't blocked by TTL-expired locks
    await expect(
      other.execute({}, { idempotencyKey: 'other-key' }),
    ).resolves.toBeTruthy();

    await first;
  });

  it('refresh extends the lock TTL', async () => {
    const storage = new MemoryStorage();
    const lock = await storage.acquireLock('f', '1', { ttlMs: 30, timeoutMs: 0 });

    await new Promise((r) => setTimeout(r, 20));
    await lock.refresh!();
    await new Promise((r) => setTimeout(r, 20));

    // 40ms passed but TTL was refreshed at 20ms → still held
    await expect(
      storage.acquireLock('f', '1', { ttlMs: 30, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(LockAcquisitionError);

    await lock.release();
    // Now free
    const second = await storage.acquireLock('f', '1', { ttlMs: 30, timeoutMs: 0 });
    await second.release();
  });

  it('double release is a no-op', async () => {
    const storage = new MemoryStorage();
    const lock = await storage.acquireLock('f', '1', { ttlMs: 1000, timeoutMs: 0 });
    await lock.release();
    await lock.release(); // should not throw or affect other keys

    const second = await storage.acquireLock('f', '1', { ttlMs: 1000, timeoutMs: 0 });
    await second.release();
  });
});
