import { describe, it, expect, vi } from 'vitest';
import {
  createFlow,
  FlowError,
  PermanentError,
  TransientError,
  StepTimeoutError,
  FlowAbortedError,
  MemoryStorage,
} from '../src/index.js';

describe('happy path', () => {
  it('runs steps in order and returns merged results', async () => {
    const flow = createFlow<{ orderId: string }>('checkout')
      .step('reserve', {
        run: async (ctx) => ({ reservationId: `r-${ctx.input.orderId}` }),
      })
      .step('charge', {
        run: async (ctx) => ({
          chargeId: `c-${ctx.input.orderId}`,
          reservation: ctx.results.reserve.reservationId,
        }),
      });

    const result = await flow.execute({ orderId: '42' });

    expect(result.reserve).toEqual({ reservationId: 'r-42' });
    expect(result.charge).toEqual({ chargeId: 'c-42', reservation: 'r-42' });
  });

  it('threads typed step results into subsequent contexts', async () => {
    const seen: unknown[] = [];
    const flow = createFlow<{ n: number }>('math')
      .step('a', { run: (ctx) => ctx.input.n + 1 })
      .step('b', {
        run: (ctx) => {
          seen.push(ctx.results.a);
          return ctx.results.a * 2;
        },
      });

    const result = await flow.execute({ n: 10 });
    expect(result).toEqual({ a: 11, b: 22 });
    expect(seen).toEqual([11]);
  });
});

describe('retry', () => {
  it('retries transient errors and succeeds', async () => {
    let attempts = 0;
    const flow = createFlow<{}>('flaky').step('go', {
      run: () => {
        attempts++;
        if (attempts < 3) throw new TransientError('nope');
        return 'ok';
      },
      retry: { maxAttempts: 5, initialDelayMs: 1, jitter: false },
    });

    const result = await flow.execute({});
    expect(result.go).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry PermanentError', async () => {
    let attempts = 0;
    const flow = createFlow<{}>('fatal').step('go', {
      run: () => {
        attempts++;
        throw new PermanentError('dead');
      },
      retry: { maxAttempts: 5, initialDelayMs: 1, jitter: false },
    });

    await expect(flow.execute({})).rejects.toBeInstanceOf(FlowError);
    expect(attempts).toBe(1);
  });

  it('honors custom shouldRetry predicate', async () => {
    let attempts = 0;
    const flow = createFlow<{}>('selective').step('go', {
      run: () => {
        attempts++;
        throw new Error('boom');
      },
      retry: {
        maxAttempts: 5,
        initialDelayMs: 1,
        jitter: false,
        shouldRetry: (_e, attempt) => attempt < 2,
      },
    });

    await expect(flow.execute({})).rejects.toBeInstanceOf(FlowError);
    expect(attempts).toBe(2);
  });

  it('stops after maxAttempts and throws FlowError', async () => {
    let attempts = 0;
    const flow = createFlow<{}>('dead').step('go', {
      run: () => {
        attempts++;
        throw new TransientError('never works');
      },
      retry: { maxAttempts: 3, initialDelayMs: 1, jitter: false },
    });

    await expect(flow.execute({})).rejects.toBeInstanceOf(FlowError);
    expect(attempts).toBe(3);
  });
});

describe('compensation (saga)', () => {
  it('compensates successful steps in reverse order on failure', async () => {
    const calls: string[] = [];

    const flow = createFlow<{}>('saga')
      .step('a', {
        run: () => {
          calls.push('a:run');
          return 'A';
        },
        compensate: () => {
          calls.push('a:compensate');
        },
      })
      .step('b', {
        run: () => {
          calls.push('b:run');
          return 'B';
        },
        compensate: () => {
          calls.push('b:compensate');
        },
      })
      .step('c', {
        run: () => {
          calls.push('c:run');
          throw new Error('c failed');
        },
        compensate: () => {
          calls.push('c:compensate');
        },
      });

    await expect(flow.execute({})).rejects.toMatchObject({
      name: 'FlowError',
      failedStep: 'c',
    });

    // c never succeeded → no c:compensate. b then a compensate in reverse.
    expect(calls).toEqual(['a:run', 'b:run', 'c:run', 'b:compensate', 'a:compensate']);
  });

  it('collects compensation errors without hiding original failure', async () => {
    const flow = createFlow<{}>('partial')
      .step('a', {
        run: () => 'A',
        compensate: () => {
          throw new Error('a-compensate-fail');
        },
      })
      .step('b', {
        run: () => {
          throw new Error('b-run-fail');
        },
      });

    try {
      await flow.execute({});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FlowError);
      const fe = err as FlowError;
      expect(fe.failedStep).toBe('b');
      expect((fe.originalError as Error).message).toBe('b-run-fail');
      expect(fe.compensationErrors).toHaveLength(1);
      expect(fe.compensationErrors[0]?.step).toBe('a');
    }
  });

  it('receives the step result in compensate', async () => {
    let seenResult: unknown = null;
    const flow = createFlow<{}>('passthrough')
      .step('reserve', {
        run: () => ({ id: 'R1' }),
        compensate: (_ctx, result) => {
          seenResult = result;
        },
      })
      .step('fail', {
        run: () => {
          throw new Error('bad');
        },
      });

    await expect(flow.execute({})).rejects.toThrow();
    expect(seenResult).toEqual({ id: 'R1' });
  });
});

describe('idempotency', () => {
  it('returns cached result on re-execution with same key', async () => {
    const runs: number[] = [];
    const storage = new MemoryStorage();

    const flow = createFlow<{ n: number }>('idem', { storage }).step('double', {
      run: (ctx) => {
        runs.push(ctx.input.n);
        return ctx.input.n * 2;
      },
    });

    const r1 = await flow.execute({ n: 5 }, { idempotencyKey: 'key-1' });
    const r2 = await flow.execute({ n: 99 }, { idempotencyKey: 'key-1' });

    expect(r1).toEqual(r2);
    expect(r1.double).toBe(10);
    expect(runs).toEqual([5]); // second execute did not run
  });

  it('re-throws on a previously compensated execution', async () => {
    const storage = new MemoryStorage();
    const flow = createFlow<{}>('dead-flow', { storage }).step('boom', {
      run: () => {
        throw new Error('kaboom');
      },
    });

    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toBeInstanceOf(FlowError);
    // second call must not re-run, must surface prior failure
    await expect(flow.execute({}, { idempotencyKey: 'k' })).rejects.toBeInstanceOf(FlowError);
  });

  it('resumes from the first incomplete step after interruption', async () => {
    const storage = new MemoryStorage();
    const runs: string[] = [];
    let firstRun = true;

    const build = () =>
      createFlow<{}>('resumable', { storage })
        .step('a', {
          run: () => {
            runs.push('a');
            return 'A';
          },
        })
        .step('b', {
          run: () => {
            runs.push('b');
            if (firstRun) throw new TransientError('simulated crash');
            return 'B';
          },
        })
        .step('c', {
          run: () => {
            runs.push('c');
            return 'C';
          },
        });

    // first execution: fails at b
    await expect(build().execute({}, { idempotencyKey: 'run-1' })).rejects.toBeInstanceOf(
      FlowError,
    );
    // state is now compensated; for a true resume test we need state='running'
    // Simulate mid-flight crash by mutating storage directly.
    const state = await storage.load('resumable', 'run-1');
    expect(state).not.toBeNull();
    // Reset state so the flow can be resumed
    if (state) {
      state.status = 'running';
      state.steps[1]!.status = 'pending';
      state.steps[1]!.attempts = 0;
      delete state.steps[1]!.error;
      state.steps[0]!.status = 'success';
      await storage.save(state);
    }

    firstRun = false;
    runs.length = 0;
    const result = await build().execute({}, { idempotencyKey: 'run-1' });
    expect(result).toEqual({ a: 'A', b: 'B', c: 'C' });
    expect(runs).toEqual(['b', 'c']); // 'a' was skipped
  });
});

describe('timeout', () => {
  it('throws StepTimeoutError when step exceeds timeout', async () => {
    const flow = createFlow<{}>('slow').step('slow', {
      run: () => new Promise((resolve) => setTimeout(resolve, 200)),
      timeout: 20,
    });

    try {
      await flow.execute({});
      expect.fail('should have timed out');
    } catch (err) {
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).originalError).toBeInstanceOf(StepTimeoutError);
    }
  });

  it('timeout errors are retried (transient)', async () => {
    let attempts = 0;
    const flow = createFlow<{}>('timey').step('work', {
      run: async () => {
        attempts++;
        if (attempts === 1) {
          await new Promise((r) => setTimeout(r, 50));
          return 'late';
        }
        return 'ok';
      },
      timeout: 10,
      retry: { maxAttempts: 2, initialDelayMs: 1, jitter: false },
    });

    const result = await flow.execute({});
    expect(result.work).toBe('ok');
    expect(attempts).toBe(2);
  });
});

describe('abort', () => {
  it('rejects mid-flight when signal aborts', async () => {
    const controller = new AbortController();
    const flow = createFlow<{}>('abortable')
      .step('a', {
        run: async () => {
          // trigger abort while this step is still running
          setTimeout(() => controller.abort(), 5);
          await new Promise((r) => setTimeout(r, 50));
          return 'A';
        },
      })
      .step('b', { run: () => 'B' });

    await expect(flow.execute({}, { signal: controller.signal })).rejects.toBeInstanceOf(
      FlowError,
    );
  });

  it('aborts during retry delay', async () => {
    const controller = new AbortController();
    const flow = createFlow<{}>('retry-abort').step('flaky', {
      run: () => {
        setTimeout(() => controller.abort(), 10);
        throw new TransientError('try again');
      },
      retry: { maxAttempts: 5, initialDelayMs: 1000, jitter: false },
    });

    try {
      await flow.execute({}, { signal: controller.signal });
      expect.fail('should have aborted');
    } catch (err) {
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).originalError).toBeInstanceOf(FlowAbortedError);
    }
  });
});

describe('hooks', () => {
  it('fires lifecycle hooks in order', async () => {
    const events: string[] = [];
    const flow = createFlow<{}>('hooked', {
      hooks: {
        onFlowStart: (e) => {
          events.push(`flow:start:${e.resumed ? 'resumed' : 'new'}`);
        },
        onFlowEnd: (e) => {
          events.push(`flow:end:${e.status}`);
        },
        onStepStart: (e) => {
          events.push(`step:start:${e.stepName}:${e.attempt}`);
        },
        onStepEnd: (e) => {
          events.push(`step:end:${e.stepName}:${e.status}`);
        },
      },
    })
      .step('a', { run: () => 'A' })
      .step('b', { run: () => 'B' });

    await flow.execute({});

    expect(events).toEqual([
      'flow:start:new',
      'step:start:a:1',
      'step:end:a:success',
      'step:start:b:1',
      'step:end:b:success',
      'flow:end:success',
    ]);
  });

  it('hook failures do not abort the flow', async () => {
    const flow = createFlow<{}>('noisy-hooks', {
      hooks: {
        onStepStart: () => {
          throw new Error('hook boom');
        },
      },
    }).step('go', { run: () => 42 });

    const result = await flow.execute({});
    expect(result.go).toBe(42);
  });

  it('fires onStepRetry with nextDelayMs', async () => {
    const retries: Array<{ attempt: number; delay: number }> = [];
    let attempts = 0;

    const flow = createFlow<{}>('retry-hook', {
      hooks: {
        onStepRetry: (e) => {
          retries.push({ attempt: e.attempt, delay: e.nextDelayMs });
        },
      },
    }).step('go', {
      run: () => {
        attempts++;
        if (attempts < 3) throw new TransientError('no');
        return 'ok';
      },
      retry: { maxAttempts: 5, initialDelayMs: 5, backoff: 'fixed', jitter: false },
    });

    await flow.execute({});
    expect(retries).toHaveLength(2);
    expect(retries[0]?.delay).toBe(5);
    expect(retries[1]?.delay).toBe(5);
  });
});

describe('skipIf', () => {
  it('skips the step and marks state skipped', async () => {
    const run = vi.fn(() => 'ran');
    const flow = createFlow<{ skip: boolean }>('maybe').step('opt', {
      skipIf: (ctx) => ctx.input.skip,
      run,
    });

    const r1 = await flow.execute({ skip: true });
    expect(run).not.toHaveBeenCalled();
    expect(r1.opt).toBeUndefined();

    const r2 = await flow.execute({ skip: false });
    expect(run).toHaveBeenCalledOnce();
    expect(r2.opt).toBe('ran');
  });
});

describe('state persistence', () => {
  it('writes state transitions to storage', async () => {
    const storage = new MemoryStorage();
    const flow = createFlow<{}>('persisted', { storage })
      .step('a', { run: () => 'A' })
      .step('b', { run: () => 'B' });

    await flow.execute({}, { idempotencyKey: 'x' });
    const state = await storage.load('persisted', 'x');
    expect(state?.status).toBe('success');
    expect(state?.steps.map((s) => s.status)).toEqual(['success', 'success']);
    expect(state?.result).toEqual({ a: 'A', b: 'B' });
  });

  it('persists compensated state', async () => {
    const storage = new MemoryStorage();
    const flow = createFlow<{}>('bad', { storage })
      .step('a', { run: () => 'A', compensate: () => {} })
      .step('b', {
        run: () => {
          throw new Error('no');
        },
      });

    await expect(flow.execute({}, { idempotencyKey: 'x' })).rejects.toThrow();
    const state = await storage.load('bad', 'x');
    expect(state?.status).toBe('compensated');
    expect(state?.steps[0]?.status).toBe('compensated');
    expect(state?.steps[1]?.status).toBe('failed');
  });
});

describe('builder', () => {
  it('rejects duplicate step names at runtime', () => {
    const flow = createFlow('dup').step('x', { run: () => 1 });
    expect(() => flow.step('x', { run: () => 2 })).toThrow(/duplicate/);
  });

  it('rejects empty flows', async () => {
    const flow = createFlow('empty');
    await expect(flow.execute({})).rejects.toThrow(/no steps/);
  });

  it('rejects anonymous flows', () => {
    // @ts-expect-error — name required
    expect(() => createFlow()).toThrow();
    expect(() => createFlow('')).toThrow();
  });
});
