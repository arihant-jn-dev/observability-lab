/**
 * Hand-written business metrics.
 *
 * Auto-instrumentation gives you *technical* metrics for free: request rate,
 * duration, status codes, DB query time. It can never give you these, because
 * it does not know what your business does. No amount of tracing tells you that
 * revenue dropped -- only that HTTP 200s are still being returned, promptly,
 * containing nothing.
 *
 * The rule of thumb: instrument the thing the business would page you about,
 * not the thing the framework already measures.
 */
import { metrics, ValueType } from '@opentelemetry/api';
import { poolStats } from './db';
import { redis } from './cache';
import { config } from './config';
import { getPathologies } from './pathologies';

// If no SDK is registered (OTEL_ENABLED=false) this returns a no-op meter, so
// every call below is safe and free. That is why stage 1 runs without OTel.
const meter = metrics.getMeter('orders-api', '1.0.0');

/* ------------------------------------------------------------------ *
 * Counters
 * ------------------------------------------------------------------ */

export const ordersCreated = meter.createCounter('orders.created', {
  description: 'Orders successfully created',
  valueType: ValueType.INT,
});

export const ordersFailed = meter.createCounter('orders.failed', {
  description: 'Order attempts that did not result in an order',
  valueType: ValueType.INT,
});

export const cacheOperations = meter.createCounter('cache.operations', {
  description: 'Cache lookups by result (hit/miss)',
  valueType: ValueType.INT,
});

/* ------------------------------------------------------------------ *
 * Histograms
 * ------------------------------------------------------------------ */

/**
 * Explicit bucket boundaries matter more than almost anything else you will
 * configure. A histogram can only answer questions its buckets are shaped for:
 * if your largest bucket is 1s and your p99 is 4s, the histogram will report
 * "p99 = 1s or more" and every percentile you compute above that boundary is a
 * fabrication produced by interpolation.
 *
 * These are in SECONDS and deliberately extend to 10s, because several
 * pathologies in this lab push latency to 5s on purpose.
 */
export const orderValue = meter.createHistogram('order.value', {
  description: 'Order total in dollars',
  unit: 'USD',
  advice: {
    explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  },
});

export const jobDuration = meter.createHistogram('job.duration', {
  description: 'Background job processing time',
  unit: 's',
  advice: {
    explicitBucketBoundaries: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
});

/**
 * Queue LAG, not queue depth, is the metric that tells you whether the worker
 * is keeping up. Depth is a snapshot that a fast worker keeps near zero even
 * under heavy load; lag measures how long a job actually waited, which is what
 * the user experiences.
 */
export const jobQueueLag = meter.createHistogram('job.queue_lag', {
  description: 'Time a job spent waiting in the queue before pickup',
  unit: 's',
  advice: {
    explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  },
});

/* ------------------------------------------------------------------ *
 * The cardinality trap
 * ------------------------------------------------------------------ */

/**
 * Deliberately dangerous. Enabled via the `cardinalityBomb` pathology.
 *
 * Every distinct combination of attribute values creates a separate time series
 * that Prometheus stores, indexes, and holds in memory FOREVER (well past the
 * point the label stopped being emitted). Attaching something unbounded -- a
 * user id, a request id, a raw URL with ids in it -- is the classic way to take
 * down your own monitoring system with your own instrumentation.
 *
 * See docs/04-cardinality.md for the guided detonation.
 */
export const cardinalityBomb = meter.createCounter('cardinality.bomb', {
  description: 'DO NOT COPY THIS. A counter with an unbounded label, for teaching.',
  valueType: ValueType.INT,
});

/* ------------------------------------------------------------------ *
 * Observable (pull-based) gauges
 * ------------------------------------------------------------------ */

/**
 * Observable instruments are polled by the SDK at export time rather than
 * pushed by your code. Use them for values that "are" rather than "happen":
 * pool sizes, queue depths, heap usage. Using a counter for these is a classic
 * mistake -- you cannot rate() a thing that goes down.
 */
const poolConnections = meter.createObservableGauge('db.pool.connections', {
  description: 'Postgres pool connections by state',
  valueType: ValueType.INT,
});

poolConnections.addCallback((observer) => {
  const stats = poolStats();
  observer.observe(stats.total - stats.idle, { state: 'in_use' });
  observer.observe(stats.idle, { state: 'idle' });
  // `waiting` > 0 is the smoking gun for connection-pool queueing: requests are
  // blocked, but neither the app nor the database looks busy.
  observer.observe(stats.waiting, { state: 'waiting' });
});

const queueDepth = meter.createObservableGauge('queue.depth', {
  description: 'Jobs currently waiting in the Redis queue',
  valueType: ValueType.INT,
});

queueDepth.addCallback(async (observer) => {
  try {
    const depth = await redis.llen(config.queueKey);
    observer.observe(depth, { queue: config.queueKey });
  } catch {
    // Redis down: report nothing rather than a misleading zero. A gap in a
    // graph and a flat zero mean very different things; do not fake the zero.
  }
});

const pathologiesActive = meter.createObservableGauge('lab.pathologies.active', {
  description: 'Which pathologies are currently switched on (1/0) -- lab only',
  valueType: ValueType.INT,
});

pathologiesActive.addCallback((observer) => {
  const p = getPathologies();
  for (const [name, value] of Object.entries(p)) {
    observer.observe((value as { enabled: boolean }).enabled ? 1 : 0, { pathology: name });
  }
});
