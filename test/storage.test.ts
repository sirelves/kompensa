import { describe, it, expect } from 'vitest';
import { MemoryStorage, createMemoryStorage } from '../src/storage/memory.js';
import type { FlowState } from '../src/types.js';

function mkState(flowName: string, flowId: string): FlowState {
  return {
    flowName,
    flowId,
    status: 'success',
    input: { x: 1 },
    steps: [{ name: 'a', status: 'success', attempts: 1, result: 'A' }],
    currentStepIndex: 0,
    metadata: {},
    createdAt: 1,
    updatedAt: 2,
    result: { a: 'A' },
  };
}

describe('MemoryStorage', () => {
  it('save/load roundtrip with deep clone isolation', async () => {
    const storage = new MemoryStorage();
    const state = mkState('f', '1');
    await storage.save(state);

    const loaded = await storage.load('f', '1');
    expect(loaded).toEqual(state);
    expect(loaded).not.toBe(state);

    // mutating the loaded copy must not affect storage
    loaded!.status = 'failed';
    const loadedAgain = await storage.load('f', '1');
    expect(loadedAgain?.status).toBe('success');
  });

  it('load returns null for unknown keys', async () => {
    const s = new MemoryStorage();
    expect(await s.load('nope', 'nope')).toBeNull();
  });

  it('delete removes state', async () => {
    const s = new MemoryStorage();
    await s.save(mkState('f', '1'));
    await s.delete!('f', '1');
    expect(await s.load('f', '1')).toBeNull();
  });

  it('snapshot returns all persisted states', async () => {
    const s = new MemoryStorage();
    await s.save(mkState('f', '1'));
    await s.save(mkState('f', '2'));
    expect(s.size).toBe(2);
    expect(s.snapshot()).toHaveLength(2);
  });

  it('factory helper works', () => {
    expect(createMemoryStorage()).toBeInstanceOf(MemoryStorage);
  });
});
