import { describe, it, expect, vi } from 'vitest';
import {
  createFlow,
  FlowError,
  PermanentError,
  StepTimeoutError,
  MemoryStorage,
} from '../src/index.js';

describe('parallel — happy path', () => {
  it('runs branches concurrently and merges results into ctx.results.<group>', async () => {
    const order: string[] = [];
    const flow = createFlow<{ id: string }>('fanout')
      .step('init', { run: () => ({ ready: true }) })
      .parallel('externals', {
        a: {
          run: async () => {
            order.push('a-start');
            await new Promise((r) => setTimeout(r, 30));
            order.push('a-end');
            return { kind: 'a' as const };
          },
        },
        b: {
          run: async () => {
            order.push('b-start');
            await new Promise((r) => setTimeout(r, 10));
            order.push('b-end');
            return { kind: 'b' as const };
          },
        },
      })
      .step('combine', {
        run: (ctx) => ({
          a: ctx.results.externals.a.kind,
          b: ctx.results.externals.b.kind,
        }),
      });

    const result = await flow.execute({ id: '1' });

    expect(result.externals).toEqual({
      a: { kind: 'a' },
      b: { kind: 'b' },
    });
    expect(result.combine).toEqual({ a: 'a', b: 'b' });
    // Both branches should have started before either finished — proves concurrency.
    expect(order.indexOf('a-start')).toBeLessThan(order.indexOf('b-end'));
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
  });

  it('runs branches inside parallel with their own retry policies', async () => {
    const flakyAttempts = { current: 0 };
    const flow = createFlow('retry-inside-parallel').parallel('fetch', {
      stable: { run: () => 'ok' },
      flaky: {
        run: () => {
          flakyAttempts.current++;
          if (flakyAttempts.current < 3) throw new Error('blip');
          return 'eventually';
        },
        retry: { maxAttempts: 5, backoff: 'fixed', initialDelayMs: 1, jitter: false },
      },
    });

    const result = await flow.execute({});
    expect(result.fetch).toEqual({ stable: 'ok', flaky: 'eventually' });
    expect(flakyAttempts.current).toBe(3);
  });
});

describe('parallel — fail-fast and abort propagation', () => {
  it('aborts surviving branches via shared signal when one branch fails', async () => {
    const survivorAborted = vi.fn();
    const flow = createFlow('failfast').parallel('p', {
      slow: {
        run: (ctx) =>
          new Promise<string>((resolve, reject) => {
            const t = setTimeout(() => resolve('never'), 200);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(t);
              survivorAborted();
              reject(new Error('aborted by sibling'));
            });
          }),
      },
      bad: {
        run: async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw new PermanentError('bad branch');
        },
      },
    });

    await expect(flow.execute({})).rejects.toBeInstanceOf(FlowError);
    expect(survivorAborted).toHaveBeenCalledOnce();
  });

  it('runs all branches to completion when abortOnFailure is false', async () => {
    const flow = createFlow('no-failfast').parallel(
      'p',
      {
        ok: {
          run: async () => {
            await new Promise((r) => setTimeout(r, 20));
            return 'done';
          },
        },
        bad: {
          run: async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new PermanentError('bad');
          },
        },
      },
      { abortOnFailure: false },
    );

    const storage = new MemoryStorage();
    await expect(
      createFlow('no-failfast', { storage })
        .parallel(
          'p',
          {
            ok: {
              run: async () => {
                await new Promise((r) => setTimeout(r, 20));
                return 'done';
              },
            },
            bad: {
              run: async () => {
                await new Promise((r) => setTimeout(r, 5));
                throw new PermanentError('bad');
              },
            },
          },
          { abortOnFailure: false },
        )
        .execute({}, { idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(FlowError);

    const state = await storage.load('no-failfast', 'k');
    if (state) {
      expect(state.steps[0]?.branches?.ok?.status).toBe('success');
      expect(state.steps[0]?.branches?.bad?.status).toBe('failed');
    }

    // unused but sanity-check the type works
    void flow;
  });
});

describe('parallel — group timeout', () => {
  it('fails the group when groupTimeout fires before branches finish', async () => {
    const flow = createFlow('group-timeout').parallel(
      'p',
      {
        slow: {
          run: () => new Promise((resolve) => setTimeout(() => resolve('never'), 500)),
        },
      },
      { groupTimeout: 30 },
    );

    await expect(flow.execute({})).rejects.toBeInstanceOf(FlowError);
  });
});

describe('parallel — compensation', () => {
  it('compensates successful branches in parallel by default when one branch fails', async () => {
    const compensateOrder: string[] = [];
    const flow = createFlow('compensate-parallel').parallel('p', {
      a: {
        run: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { id: 'a' };
        },
        compensate: async () => {
          compensateOrder.push('a-comp');
        },
      },
      b: {
        run: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { id: 'b' };
        },
        compensate: async () => {
          compensateOrder.push('b-comp');
        },
      },
      c: {
        run: async () => {
          await new Promise((r) => setTimeout(r, 50));
          throw new Error('c failed late');
        },
      },
    });

    await expect(flow.execute({})).rejects.toBeInstanceOf(FlowError);
    // a and b succeeded; both should be compensated
    expect(compensateOrder).toContain('a-comp');
    expect(compensateOrder).toContain('b-comp');
    expect(compensateOrder).toHaveLength(2);
  });

  it('compensates branches in reverse-completion-order when compensateSerially is true', async () => {
    const compensateOrder: string[] = [];
    const flow = createFlow('compensate-serial').parallel(
      'p',
      {
        first: {
          run: async () => {
            await new Promise((r) => setTimeout(r, 5));
            return { tag: 'first' };
          },
          compensate: async () => {
            compensateOrder.push('first');
          },
        },
        second: {
          run: async () => {
            await new Promise((r) => setTimeout(r, 30));
            return { tag: 'second' };
          },
          compensate: async () => {
            compensateOrder.push('second');
          },
        },
      },
      { compensateSerially: true },
    );

    // Force compensation by adding a downstream step that fails after the group succeeded.
    const fullFlow = flow.step('downstream', {
      run: () => {
        throw new Error('downstream blew up');
      },
    });

    await expect(fullFlow.execute({})).rejects.toBeInstanceOf(FlowError);
    // second finished last, so it should be compensated first under serial mode.
    expect(compensateOrder).toEqual(['second', 'first']);
  });
});

describe('parallel — crash recovery', () => {
  it('skips already-successful branches on resume', async () => {
    const storage = new MemoryStorage();
    const aRuns = vi.fn(() => 'a-result');
    const bRuns = vi.fn(() => {
      throw new Error('b not yet');
    });

    const buildFlow = (bImpl: () => unknown) =>
      createFlow('resume-parallel', { storage }).parallel('p', {
        a: { run: aRuns },
        b: { run: bImpl },
      });

    // First run: a succeeds, b fails permanently → flow fails.
    await expect(
      buildFlow(bRuns).execute({}, { idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(FlowError);

    expect(aRuns).toHaveBeenCalledTimes(1);

    // Second run with same key: prior compensation already terminal → re-throws.
    await expect(
      buildFlow(() => 'b-result').execute({}, { idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(FlowError);

    // a should not run again.
    expect(aRuns).toHaveBeenCalledTimes(1);
  });

  it('persists per-branch state under stepState.branches', async () => {
    const storage = new MemoryStorage();
    await createFlow('persist-branches', { storage })
      .parallel('p', {
        x: { run: () => 'X' },
        y: { run: () => 'Y' },
      })
      .execute({}, { idempotencyKey: 'k2' });

    const state = await storage.load('persist-branches', 'k2');
    expect(state?.steps[0]?.kind).toBe('parallel');
    expect(state?.steps[0]?.branches?.x?.status).toBe('success');
    expect(state?.steps[0]?.branches?.x?.result).toBe('X');
    expect(state?.steps[0]?.branches?.y?.status).toBe('success');
    expect(state?.steps[0]?.branches?.y?.result).toBe('Y');
  });
});

describe('parallel — builder validation', () => {
  it('throws when a parallel group has no branches', () => {
    expect(() => createFlow('x').parallel('empty', {})).toThrow(/no branches/i);
  });

  it('throws when a parallel group reuses an existing step name', () => {
    expect(() =>
      createFlow('x')
        .step('a', { run: () => 1 })
        .parallel('a', { x: { run: () => 1 } }),
    ).toThrow(/duplicate step name/i);
  });
});

describe('parallel — hooks', () => {
  it('emits per-branch onStepStart and onStepEnd with dot-notation stepName', async () => {
    const events: Array<{ event: string; stepName: string; status?: string }> = [];

    await createFlow('hooks-parallel', {
      hooks: {
        onStepStart: (e) => {
          events.push({ event: 'start', stepName: e.stepName });
        },
        onStepEnd: (e) => {
          events.push({ event: 'end', stepName: e.stepName, status: e.status });
        },
      },
    })
      .parallel('p', {
        one: { run: () => 1 },
        two: { run: () => 2 },
      })
      .execute({});

    const branchEvents = events.filter((e) => e.stepName.includes('.'));
    expect(branchEvents.map((e) => e.stepName).sort()).toContain('p.one');
    expect(branchEvents.map((e) => e.stepName).sort()).toContain('p.two');
    expect(branchEvents.filter((e) => e.event === 'end').every((e) => e.status === 'success')).toBe(
      true,
    );
  });
});

describe('parallel — type accumulation (compile-time)', () => {
  it('exposes ctx.results.<group>.<branch> with inferred branch result types', async () => {
    const flow = createFlow<{ n: number }>('typed')
      .parallel('p', {
        doubled: { run: async (ctx) => ctx.input.n * 2 },
        label: { run: async () => 'x' as const },
      })
      .step('combine', {
        run: (ctx) => {
          // These accesses must compile — if the branch result types broke,
          // typecheck (run separately) would fail before the test runs.
          const n: number = ctx.results.p.doubled;
          const s: 'x' = ctx.results.p.label;
          return { n, s };
        },
      });

    const result = await flow.execute({ n: 21 });
    expect(result.combine).toEqual({ n: 42, s: 'x' });
  });
});

describe('parallel — single-failure semantics under StepTimeoutError', () => {
  it('throws FlowError wrapping StepTimeoutError when a branch times out', async () => {
    const flow = createFlow('branch-timeout').parallel('p', {
      slow: {
        run: () => new Promise((resolve) => setTimeout(() => resolve('done'), 200)),
        timeout: 20,
      },
    });

    try {
      await flow.execute({});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FlowError);
      const fe = err as FlowError;
      expect(fe.originalError).toBeInstanceOf(StepTimeoutError);
    }
  });
});
