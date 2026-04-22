import type { AcquireLockOptions, FlowState, Lock, StorageAdapter } from '../types.js';
import { LockAcquisitionError } from '../errors.js';
import { sleep } from '../utils/sleep.js';
import { generateId } from '../utils/id.js';

/**
 * Structural subset of ioredis' `Redis` class. Only the methods we use are
 * required, so both `ioredis` and compatible clients work.
 */
export interface RedisLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisStorageOptions {
  client: RedisLike;
  /** Prefix applied to all keys written by this adapter. Default: `flowguard`. */
  keyPrefix?: string;
  /** Polling interval while waiting for a contested lock, in ms. Default: 50. */
  lockPollMs?: number;
}

// Safe release — only delete the lock if the token matches. Prevents a
// process whose TTL has expired from deleting a lock another worker now holds.
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

// Atomic refresh — only extend TTL if the token still matches.
const REFRESH_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Redis-backed storage with Redlock-style single-node locks.
 *
 * State is serialized to JSON. Locks use `SET NX PX` for atomic acquisition
 * plus a Lua-verified token on release, so a process whose TTL expired cannot
 * accidentally release the lock held by a newer owner.
 *
 * @example
 * import Redis from 'ioredis';
 * import { RedisStorage } from 'flowguard/storage/redis';
 *
 * const storage = new RedisStorage({ client: new Redis(process.env.REDIS_URL) });
 * const flow = createFlow('checkout', { storage }).step(...)
 */
export class RedisStorage implements StorageAdapter {
  private readonly client: RedisLike;
  private readonly keyPrefix: string;
  private readonly lockPollMs: number;

  constructor(opts: RedisStorageOptions) {
    if (!opts.client) {
      throw new Error('flowguard: RedisStorage requires a `client` option');
    }
    this.client = opts.client;
    this.keyPrefix = opts.keyPrefix ?? 'flowguard';
    this.lockPollMs = opts.lockPollMs ?? 50;
  }

  private stateKey(flowName: string, flowId: string): string {
    return `${this.keyPrefix}:state:${flowName}:${flowId}`;
  }

  private lockKey(flowName: string, flowId: string): string {
    return `${this.keyPrefix}:lock:${flowName}:${flowId}`;
  }

  async load(flowName: string, flowId: string): Promise<FlowState | null> {
    const raw = await this.client.get(this.stateKey(flowName, flowId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FlowState;
    } catch {
      return null;
    }
  }

  async save(state: FlowState): Promise<void> {
    await this.client.set(
      this.stateKey(state.flowName, state.flowId),
      JSON.stringify(state),
    );
  }

  async delete(flowName: string, flowId: string): Promise<void> {
    await this.client.del(this.stateKey(flowName, flowId));
  }

  async acquireLock(
    flowName: string,
    flowId: string,
    options: AcquireLockOptions,
  ): Promise<Lock> {
    const { ttlMs, timeoutMs } = options;
    const key = this.lockKey(flowName, flowId);
    const token = generateId('lk');

    // Fast-path: atomic SET NX PX.
    const ok = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    if (ok === 'OK') return this.makeLock(key, token, ttlMs);

    if (timeoutMs <= 0) {
      throw new LockAcquisitionError(flowName, flowId, 'lock is held');
    }

    // Poll until acquired or timeout elapses.
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - start);
      await sleep(Math.min(this.lockPollMs, remaining));
      const retry = await this.client.set(key, token, 'PX', ttlMs, 'NX');
      if (retry === 'OK') return this.makeLock(key, token, ttlMs);
    }

    throw new LockAcquisitionError(
      flowName,
      flowId,
      `wait timeout after ${timeoutMs}ms`,
    );
  }

  private makeLock(key: string, token: string, ttlMs: number): Lock {
    const client = this.client;
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await client.eval(RELEASE_SCRIPT, 1, key, token);
      },
      async refresh() {
        if (released) return;
        await client.eval(REFRESH_SCRIPT, 1, key, token, ttlMs);
      },
    };
  }
}

export function createRedisStorage(opts: RedisStorageOptions): RedisStorage {
  return new RedisStorage(opts);
}
