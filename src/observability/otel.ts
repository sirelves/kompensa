/**
 * OpenTelemetry adapter for kompensa.
 *
 * Returns a {@link FlowHooks} object that opens spans for the flow and each
 * step, attaches retries as events on the step span, and surfaces compensation
 * as a sibling span. Plug it into `FlowConfig.hooks` and your existing OTel
 * pipeline picks the spans up automatically.
 *
 * @example
 * import { trace } from '@opentelemetry/api';
 * import { createOtelHooks } from 'kompensa/observability/otel';
 *
 * const flow = createFlow('checkout', {
 *   hooks: createOtelHooks({ tracer: trace.getTracer('my-service') }),
 * });
 *
 * Peer dependency: `@opentelemetry/api` ^1. Optional — only required when this
 * subpath is imported.
 */
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, Context, Span, Tracer } from '@opentelemetry/api';
import type { FlowHooks } from '../types.js';

export interface CreateOtelHooksOptions {
  /** Tracer obtained from `trace.getTracer('your-service')`. */
  tracer: Tracer;
  /**
   * Prefix for span names. Default `"kompensa"` produces names like
   * `kompensa.flow.<flowName>` and `kompensa.step.<stepName>`.
   */
  spanPrefix?: string;
  /** Attributes added to every span emitted by this adapter. */
  baseAttributes?: Attributes;
}

/**
 * Build a {@link FlowHooks} implementation that emits OpenTelemetry spans
 * mirroring the lifecycle of a kompensa flow.
 *
 * Span hierarchy:
 * ```
 * kompensa.flow.<flowName>
 *  ├─ kompensa.step.<stepName>          (one per sequential step)
 *  ├─ kompensa.step.<group>.<branch>    (one per parallel branch)
 *  └─ kompensa.compensate.<stepName>    (only when compensation runs)
 * ```
 *
 * Each step span carries `kompensa.step.attempts`, retries are recorded as
 * `retry` events on the same span, and failures call `recordException` so the
 * stack trace shows up on the tracing backend.
 */
export function createOtelHooks(opts: CreateOtelHooksOptions): FlowHooks {
  const { tracer, spanPrefix = 'kompensa', baseAttributes = {} } = opts;

  // Per-flow root spans (and the OTel context that has them set as active —
  // child spans are anchored to that context so the hierarchy is correct in
  // any backend).
  const flowSpans = new Map<string, { span: Span; ctx: Context }>();
  // Step + compensation spans keyed by `${flowId}::${stepName}` and
  // `${flowId}::comp::${stepName}` respectively.
  const stepSpans = new Map<string, Span>();

  const stepKey = (flowId: string, stepName: string) => `${flowId}::${stepName}`;
  const compKey = (flowId: string, stepName: string) => `${flowId}::comp::${stepName}`;

  return {
    onFlowStart(e) {
      const span = tracer.startSpan(`${spanPrefix}.flow.${e.flowName}`, {
        attributes: {
          ...baseAttributes,
          'kompensa.flow.name': e.flowName,
          'kompensa.flow.id': e.flowId,
          'kompensa.flow.resumed': e.resumed,
        },
      });
      const ctx = trace.setSpan(context.active(), span);
      flowSpans.set(e.flowId, { span, ctx });
    },

    onFlowEnd(e) {
      const entry = flowSpans.get(e.flowId);
      if (!entry) return;
      entry.span.setAttributes({
        'kompensa.flow.status': e.status,
        'kompensa.flow.duration_ms': e.durationMs,
      });
      if (e.status === 'success') {
        entry.span.setStatus({ code: SpanStatusCode.OK });
      } else {
        entry.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage(e.error),
        });
        if (e.error instanceof Error) entry.span.recordException(e.error);
      }
      entry.span.end();
      flowSpans.delete(e.flowId);
    },

    onStepStart(e) {
      const k = stepKey(e.flowId, e.stepName);
      const existing = stepSpans.get(k);
      if (existing) {
        // Retry attempt — same logical step, record an event rather than open
        // a sibling span. Attempt 1 already opened the span on the first call.
        existing.addEvent('attempt', { attempt: e.attempt });
        return;
      }
      const flowEntry = flowSpans.get(e.flowId);
      const parentCtx = flowEntry?.ctx ?? context.active();
      const span = tracer.startSpan(
        `${spanPrefix}.step.${e.stepName}`,
        {
          attributes: {
            ...baseAttributes,
            'kompensa.flow.name': e.flowName,
            'kompensa.flow.id': e.flowId,
            'kompensa.step.name': e.stepName,
            'kompensa.step.index': e.stepIndex,
          },
        },
        parentCtx,
      );
      stepSpans.set(k, span);
    },

    onStepRetry(e) {
      const span = stepSpans.get(stepKey(e.flowId, e.stepName));
      if (!span) return;
      span.addEvent('retry', {
        attempt: e.attempt,
        next_delay_ms: e.nextDelayMs,
        error_message: errorMessage(e.error),
      });
      if (e.error instanceof Error) span.recordException(e.error);
    },

    onStepEnd(e) {
      const k = stepKey(e.flowId, e.stepName);
      const span = stepSpans.get(k);
      if (!span) return;
      span.setAttributes({
        'kompensa.step.status': e.status,
        'kompensa.step.attempts': e.attempts,
        'kompensa.step.duration_ms': e.durationMs,
      });
      if (e.status === 'success' || e.status === 'skipped') {
        span.setStatus({ code: SpanStatusCode.OK });
      } else {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage(e.error),
        });
        if (e.error instanceof Error) span.recordException(e.error);
      }
      span.end();
      stepSpans.delete(k);
    },

    onCompensate(e) {
      const k = compKey(e.flowId, e.stepName);
      if (e.status === 'compensating') {
        // Open a sibling span under the flow span so operators can see
        // exactly which step rolled back and how long the compensation took.
        const flowEntry = flowSpans.get(e.flowId);
        const parentCtx = flowEntry?.ctx ?? context.active();
        const span = tracer.startSpan(
          `${spanPrefix}.compensate.${e.stepName}`,
          {
            attributes: {
              ...baseAttributes,
              'kompensa.flow.name': e.flowName,
              'kompensa.flow.id': e.flowId,
              'kompensa.step.name': e.stepName,
              'kompensa.step.index': e.stepIndex,
            },
          },
          parentCtx,
        );
        stepSpans.set(k, span);
        return;
      }
      const span = stepSpans.get(k);
      if (!span) return;
      if (e.status === 'compensated') {
        span.setStatus({ code: SpanStatusCode.OK });
      } else {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage(e.error),
        });
        if (e.error instanceof Error) span.recordException(e.error);
      }
      span.end();
      stepSpans.delete(k);
    },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err == null) return '';
  return String(err);
}
