// ⚠️  MUST BE THE FIRST IMPORT. See the header comment in otel.ts.
import './otel';

import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { config } from './config';
import { logger } from './logger';
import { pool, waitForDb } from './db';
import { redis, waitForRedis } from './cache';
import { contextFromJob, type OrderJob } from './queue';
import { jobDuration, jobQueueLag } from './metrics';
import './metrics';

const tracer = trace.getTracer('orders-worker');

let running = true;

async function processJob(job: OrderJob): Promise<void> {
  /**
   * Reattach to the producer's trace.
   *
   * `contextFromJob` rebuilds the context that /orders or /checkout injected
   * into the payload. Starting the span inside that context makes it a CHILD of
   * the request span -- so in Tempo you see one trace that begins with an HTTP
   * POST and continues, seconds later, in a different process.
   *
   * Change `contextFromJob(job)` to `context.active()` and the worker's spans
   * become orphan root traces. Everything still "works"; you simply lose the
   * ability to ever answer "what caused this job to run?".
   */
  const parentCtx = contextFromJob(job);

  await tracer.startActiveSpan(
    'process order job',
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'redis',
        'messaging.destination.name': config.queueKey,
        'order.id': job.orderId,
      },
    },
    parentCtx,
    async (span) => {
      const startedAt = Date.now();

      // Queue lag: how long this job sat waiting. This is the number that tells
      // you whether the worker pool is keeping up -- not queue depth, which a
      // fast worker keeps near zero even while badly overloaded.
      const lagSeconds = (startedAt - job.enqueuedAt) / 1000;
      jobQueueLag.record(lagSeconds, { queue: config.queueKey });
      span.setAttribute('messaging.queue_lag_seconds', lagSeconds);

      try {
        // Simulated fulfilment work, plus a real DB write so the worker shows
        // up in Postgres metrics and produces child spans of its own.
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
        await pool.query(`UPDATE orders SET status = 'shipped' WHERE id = $1`, [job.orderId]);

        span.setStatus({ code: SpanStatusCode.OK });
        logger.info(
          { orderId: job.orderId, lagSeconds: +lagSeconds.toFixed(3) },
          'job processed',
        );
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        logger.error({ err, orderId: job.orderId }, 'job failed');
      } finally {
        jobDuration.record((Date.now() - startedAt) / 1000, { queue: config.queueKey });
        span.end();
      }
    },
  );
}

async function loop(): Promise<void> {
  while (running) {
    let raw: string | null = null;

    try {
      /**
       * Poll with tracing SUPPRESSED.
       *
       * Without this, every empty poll -- five per second, forever -- creates a
       * root span in Tempo. Within an hour your trace store is 99% "the worker
       * asked if there was any work and there wasn't", drowning the traces you
       * actually care about and costing real money in a hosted backend.
       *
       * Deciding what NOT to record is as much a part of instrumentation as
       * deciding what to record.
       */
      raw = await context.with(suppressTracing(context.active()), () =>
        redis.rpop(config.queueKey),
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'queue poll failed');
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    if (!raw) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    try {
      await processJob(JSON.parse(raw) as OrderJob);
    } catch (err) {
      logger.error({ err }, 'malformed job discarded');
    }
  }
}

async function main() {
  await waitForDb();
  await waitForRedis();
  logger.info({ queue: config.queueKey, otel: config.otelEnabled }, 'worker started');

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    running = false;
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await loop();
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
