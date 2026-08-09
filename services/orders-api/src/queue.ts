/**
 * A minimal Redis list queue.
 *
 * ============ THE LESSON IN THIS FILE ============
 * Traces do NOT cross async boundaries for free.
 *
 * Auto-instrumentation propagates trace context over HTTP because it can patch
 * the HTTP client and inject a `traceparent` header. A queue has no headers --
 * it has whatever bytes you chose to push. So if you want the worker's spans to
 * join the request's trace, YOU have to carry the context across, by hand.
 *
 * That is what `propagation.inject` / `propagation.extract` do below. Skip
 * them, and the worker still produces perfectly good traces -- they are just
 * orphans, disconnected from the request that caused them, and you will never
 * be able to answer "why did this job run?".
 * ================================================
 */
import { context, propagation, trace } from '@opentelemetry/api';
import { redis } from './cache';
import { config } from './config';

export type OrderJob = {
  orderId: number;
  customerId: number;
  totalCents: number;
  /** Epoch ms at enqueue time -- lets the worker compute true queue lag. */
  enqueuedAt: number;
  /** W3C trace context carrier, e.g. { traceparent: "00-<trace>-<span>-01" }. */
  _otel?: Record<string, string>;
};

export async function enqueueOrderJob(
  job: Omit<OrderJob, 'enqueuedAt' | '_otel'>,
): Promise<void> {
  const carrier: Record<string, string> = {};

  // Serialise the ACTIVE span context into a plain object we can put on the
  // wire. This is the same W3C format HTTP uses, just carried in the payload.
  propagation.inject(context.active(), carrier);

  const payload: OrderJob = {
    ...job,
    enqueuedAt: Date.now(),
    _otel: carrier,
  };

  await redis.lpush(config.queueKey, JSON.stringify(payload));

  // Annotate the producing span so the trace shows the handoff explicitly.
  trace.getActiveSpan()?.addEvent('job.enqueued', { 'order.id': job.orderId });
}

/** Rebuild the producer's context so the worker's spans attach to its trace. */
export function contextFromJob(job: OrderJob) {
  return propagation.extract(context.active(), job._otel ?? {});
}
