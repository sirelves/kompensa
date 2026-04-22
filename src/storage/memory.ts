import type { FlowState, StorageAdapter } from '../types.js';
import { deepClone } from '../utils/clone.js';

/**
 * In-memory storage adapter. Safe default for tests, single-process services,
 * and browser/mobile usage where durability isn't required.
 *
 * State is cloned on both read and write so callers can't accidentally mutate
 * stored snapshots.
 */
export class MemoryStorage implements StorageAdapter {
  private readonly store = new Map<string, FlowState>();

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

  /** Return every persisted state (useful for introspection/tests). */
  snapshot(): FlowState[] {
    return Array.from(this.store.values(), (s) => deepClone(s));
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

export function createMemoryStorage(): MemoryStorage {
  return new MemoryStorage();
}
