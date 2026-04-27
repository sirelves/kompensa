import { describe, it, expect } from 'vitest';
import type { Span, Tracer, Context, Attributes, SpanStatus } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { createFlow, FlowError, MemoryStorage, PermanentError } from '../src/index.js';
import { createOtelHooks } from '../src/observability/otel.js';

interface CapturedSpan {
  name: string;
  attributes: Attributes;
  events: Array<{ name: string; attributes?: Attributes }>;
  status: SpanStatus | null;
  exceptions: unknown[];
  ended: boolean;
  parentName: string | null;
}

function createMockTracer(): { tracer: Tracer; spans: CapturedSpan[] } {
  const spans: CapturedSpan[] = [];

  function makeSpan(name: string, parent: CapturedSpan | null): { span: Span; record: CapturedSpan } {
    const record: CapturedSpan = {
      name,
      attributes: {},
      events: [],
      status: null,
      exceptions: [],
      ended: false,
      parentName: parent?.name ?? null,
    };
    const span: Span = {
      spanContext: () =>
        ({
          traceId: '0'.repeat(32),
          spanId: name.replace(/\W/g, '').padEnd(16, '0').slice(0, 16),
          traceFlags: 1,
        }) as ReturnType<Span['spanContext']>,
      setAttribute: (k, v) => {
        record.attributes[k] = v;
        return span;
      },
      setAttributes: (a) => {
        Object.assign(record.attributes, a);
        return span;
      },
      addEvent: (n, a) => {
        record.events.push({ name: n, attributes: a as Attributes | undefined });
        return span;
      },
      addLink: () => span,
      addLinks: () => span,
      setStatus: (s) => {
        record.status = s;
        return span;
      },
      updateName: () => span,
      end: () => {
        record.ended = true;
      },
      isRecording: () => true,
      recordException: (err) => {
        record.exceptions.push(err);
      },
    };
    spans.push(record);
    return { span, record };
  }

  // Map context → active span
  const ctxToSpan = new WeakMap<object, CapturedSpan>();

  const tracer: Tracer = {
    startSpan: (name, options, ctx) => {
      const parent =
        ctx && typeof ctx === 'object' ? (ctxToSpan.get(ctx as object) ?? null) : null;
      const { span, record } = makeSpan(name, parent);
      // Honor initial attributes set on creation — same as real OTel SDKs.
      if (options?.attributes) Object.assign(record.attributes, options.attributes);
      return span;
    },
    startActiveSpan: (() => {
      throw new Error('not implemented in mock');
    }) as Tracer['startActiveSpan'],
  };
  // unused — silences ts-unused warnings while we keep the WeakMap alive for
  // possible future parent-context capture extensions.
  void ctxToSpan;

  return { tracer, spans };
}

describe('otel hooks — basic flow', () => {
  it('opens a flow span and a child step span', async () => {
    const { tracer, spans } = createMockTracer();

    await createFlow('checkout', {
      hooks: createOtelHooks({ tracer }),
    })
      .step('reserve', { run: () => ({ ok: true }) })
      .execute({}, { idempotencyKey: 'k1' });

    const flowSpan = spans.find((s) => s.name === 'kompensa.flow.checkout');
    const stepSpan = spans.find((s) => s.name === 'kompensa.step.reserve');

    expect(flowSpan).toBeDefined();
    expect(stepSpan).toBeDefined();
    expect(flowSpan?.ended).toBe(true);
    expect(stepSpan?.ended).toBe(true);
    expect(flowSpan?.status?.code).toBe(SpanStatusCode.OK);
    expect(stepSpan?.status?.code).toBe(SpanStatusCode.OK);
    expect(stepSpan?.attributes['kompensa.step.status']).toBe('success');
    expect(flowSpan?.attributes['kompensa.flow.id']).toBe('k1');
  });

  it('records retry attempts as events on the step span', async () => {
    const { tracer, spans } = createMockTracer();
    let attempts = 0;

    await createFlow('flaky', {
      hooks: createOtelHooks({ tracer }),
    })
      .step('callApi', {
        run: () => {
          attempts++;
          if (attempts < 3) throw new Error('blip');
          return 'ok';
        },
        retry: { maxAttempts: 5, backoff: 'fixed', initialDelayMs: 1, jitter: false },
      })
      .execute({});

    const stepSpan = spans.find((s) => s.name === 'kompensa.step.callApi');
    expect(stepSpan).toBeDefined();
    const retryEvents = stepSpan!.events.filter((e) => e.name === 'retry');
    expect(retryEvents.length).toBe(2); // two retries before the third attempt succeeds
    expect(stepSpan!.attributes['kompensa.step.attempts']).toBe(3);
    expect(stepSpan!.status?.code).toBe(SpanStatusCode.OK);
  });

  it('marks the flow span and failing step span as ERROR on failure', async () => {
    const { tracer, spans } = createMockTracer();

    await expect(
      createFlow('bad', {
        hooks: createOtelHooks({ tracer }),
      })
        .step('boom', {
          run: () => {
            throw new PermanentError('nope');
          },
        })
        .execute({}),
    ).rejects.toBeInstanceOf(FlowError);

    const flowSpan = spans.find((s) => s.name === 'kompensa.flow.bad');
    const stepSpan = spans.find((s) => s.name === 'kompensa.step.boom');

    expect(flowSpan?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(stepSpan?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(stepSpan?.exceptions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('otel hooks — compensation', () => {
  it('opens a kompensa.compensate.<stepName> span when rollback runs', async () => {
    const { tracer, spans } = createMockTracer();

    await expect(
      createFlow('compensated', {
        hooks: createOtelHooks({ tracer }),
      })
        .step('reserve', {
          run: () => ({ id: 'r' }),
          compensate: async () => undefined,
        })
        .step('charge', {
          run: () => {
            throw new Error('charge failed');
          },
        })
        .execute({}),
    ).rejects.toBeInstanceOf(FlowError);

    const compensateSpan = spans.find((s) => s.name === 'kompensa.compensate.reserve');
    expect(compensateSpan).toBeDefined();
    expect(compensateSpan?.ended).toBe(true);
    expect(compensateSpan?.status?.code).toBe(SpanStatusCode.OK);
  });
});

describe('otel hooks — parallel groups', () => {
  it('emits one span per branch with dot-notation step name', async () => {
    const { tracer, spans } = createMockTracer();

    await createFlow('fanout', {
      hooks: createOtelHooks({ tracer }),
    })
      .parallel('p', {
        a: { run: () => 1 },
        b: { run: () => 2 },
      })
      .execute({});

    const branchA = spans.find((s) => s.name === 'kompensa.step.p.a');
    const branchB = spans.find((s) => s.name === 'kompensa.step.p.b');

    expect(branchA).toBeDefined();
    expect(branchB).toBeDefined();
    expect(branchA?.ended).toBe(true);
    expect(branchB?.ended).toBe(true);
    expect(branchA?.attributes['kompensa.step.name']).toBe('p.a');
    expect(branchB?.attributes['kompensa.step.name']).toBe('p.b');
  });
});

describe('otel hooks — customization', () => {
  it('respects spanPrefix and baseAttributes', async () => {
    const { tracer, spans } = createMockTracer();

    await createFlow('custom', {
      hooks: createOtelHooks({
        tracer,
        spanPrefix: 'svc',
        baseAttributes: { 'service.name': 'orders', 'deployment.env': 'prod' },
      }),
    })
      .step('a', { run: () => 1 })
      .execute({});

    const flowSpan = spans.find((s) => s.name === 'svc.flow.custom');
    expect(flowSpan).toBeDefined();
    expect(flowSpan?.attributes['service.name']).toBe('orders');
    expect(flowSpan?.attributes['deployment.env']).toBe('prod');
    const stepSpan = spans.find((s) => s.name === 'svc.step.a');
    expect(stepSpan?.attributes['service.name']).toBe('orders');
  });
});

describe('otel hooks — defensive', () => {
  it('keeps the flow alive when the tracer throws', async () => {
    const exploding: Tracer = {
      startSpan: () => {
        throw new Error('tracer broken');
      },
      startActiveSpan: (() => {
        throw new Error('not implemented');
      }) as Tracer['startActiveSpan'],
    };

    // The flow MUST still complete — kompensa hook errors are caught
    // at the executor level (`invokeHook` logs warnings, never re-throws).
    const result = await createFlow('survives', {
      hooks: createOtelHooks({ tracer: exploding }),
    })
      .step('a', { run: () => 'ok' })
      .execute({});

    expect(result.a).toBe('ok');
  });
});
