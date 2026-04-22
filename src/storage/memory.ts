import type { AcquireLockOptions, FlowState, Lock, StorageAdapter } from '../types.js';
import { LockAcquisitionError } from '../errors.js';
import { deepClone } from '../utils/clone.js';

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type LockEntry = {
  released: boolean;
  ttlTimer: ReturnType<typeof setTimeout>;
};

/**
 * In-memory storage adapter. Safe default for tests, single-process services,
 * and browser/mobile usage where durability isn't required.
 *
 * Implements in-process locking — sufficient for single-process safety.
 * For multi-worker deployments use a durable adapter (Postgres/Redis) whose
 * locks survive across processes.
 *
 * State is cloned on both read and write so callers can't accidentally mutate
 * stored snapshots.
 */
export class MemoryStorage implements StorageAdapter {
  private readonly store = new Map<string, FlowState>();
  private readonly locks = new Map<string, LockEntry>();
  private readonly waiters = new Map<string, Waiter[]>();

  private key(flowName: string, flowId: string): string {
    return `${flowName}:${flowId}`;
  }

  async load(flowName: string, flowId: string): Promise<FlowState | null> {
    const entry = this.store.get(this.key(flowName, flowId));
    return entry ? deepClone(entry) : null;
  }

  async save(state: FlowState): Promise<void> {
    this.store.set(this.key(state.flowName, state.flowId), deepClone(state));
  }

  async delete(flowName: string, flowId: string): Promise<void> {
    this.store.delete(this.key(flowName, flowId));
  }

  async acquireLock(
    flowName: string,
    flowId: string,
    options: AcquireLockOptions,
  ): Promise<Lock> {
    const key = this.key(flowName, flowId);
    const { ttlMs, timeoutMs } = options;

    // Fast path: lock free.
    if (!this.locks.has(key)) {
      return this.claim(key, ttlMs);
    }

    // Fail fast if the caller declined to wait.
    if (timeoutMs <= 0) {
      throw new LockAcquisitionError(flowName, flowId, 'lock is held');
    }

    // Wait for the current holder (or TTL) to release, then claim.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(key);
        if (list) {
          const idx = list.findIndex((w) => w.timer === timer);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.waiters.delete(key);
        }
        reject(new LockAcquisitionError(flowName, flowId, `wait timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const list = this.waiters.get(key) ?? [];
      list.push({ resolve, reject, timer });
      this.waiters.set(key, list);
    });

    // At this point the prior holder has released and we've been selected —
    // claim synchronously before any other microtask can interleave.
    return this.claim(key, ttlMs);
  }

  private claim(key: string, ttlMs: number): Lock {
    const entry: LockEntry = {
      released: false,
      // placeholder; assigned just below so closure can reference `entry`.
      ttlTimer: null as unknown as ReturnType<typeof setTimeout>,
    };

    const releaseImpl = (): void => {
      if (entry.released) return;
      entry.released = true;
      clearTimeout(entry.ttlTimer);
      if (this.locks.get(key) === entry) {
        this.locks.delete(key);
      }
      // Wake the next FIFO waiter, if any.
      const list = this.waiters.get(key);
      if (list && list.length > 0) {
        const next = list.shift()!;
        if (list.length === 0) this.waiters.delete(key);
        clearTimeout(next.timer);
        next.resolve();
      }
    };

    entry.ttlTimer = setTimeout(releaseImpl, ttlMs);
    this.locks.set(key, entry);

    return {
      async release() {
        releaseImpl();
      },
      async refresh() {
        if (entry.released) return;
        clearTimeout(entry.ttlTimer);
        entry.ttlTimer = setTimeout(releaseImpl, ttlMs);
      },
    };
  }

  /** Return every persisted state (useful for introspection/tests). */
  snapshot(): FlowState[] {
    return Array.from(this.store.values(), (s) => deepClone(s));
  }

  clear(): void {
    // Cancel all pending waiters and timers so tests don't leak handles.
    for (const [, entry] of this.locks) clearTimeout(entry.ttlTimer);
    for (const [, list] of this.waiters) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.reject(new Error('storage cleared'));
      }
    }
    this.store.clear();
    this.locks.clear();
    this.waiters.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

export function createMemoryStorage(): MemoryStorage {
  return new MemoryStorage();
}
