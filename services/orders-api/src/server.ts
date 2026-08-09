import Fastify from 'fastify';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { logger } from './logger';
import {
  getPathologies,
  sleep,
  burnCpu,
  leakMemory,
  shouldFail,
} from './pathologies';
import { healthRoutes } from './routes/health';
import { adminRoutes } from './routes/admin';
import { productRoutes } from './routes/products';
import { orderRoutes } from './routes/orders';
import { checkoutRoutes } from './routes/checkout';

export function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    // Fastify's own request/response logs are useful, and because our pino
    // instance carries the trace mixin, they are automatically correlated too.
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
  });

  /**
   * ==================== THE PATHOLOGY HOOK ====================
   * Runs before every handler. Order matters and is deliberate:
   *
   *   1. errorRate  -- fail fast, before doing any work (a real 500 usually
   *                    happens early, and burning CPU before failing would
   *                    conflate two pathologies)
   *   2. cpuBurn    -- blocks the event loop synchronously
   *   3. memLeak    -- allocates and retains
   *   4. slow       -- awaits, yielding the event loop
   *
   * /admin and /health are exempt. If they were not, `errorRate: 100` would
   * break the very endpoint you need to switch it back off.
   * ============================================================
   */
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (url.startsWith('/admin') || url.startsWith('/health') || url.startsWith('/ready')) {
      return;
    }

    const p = getPathologies();
    const span = trace.getActiveSpan();
    const applied: string[] = [];

    if (p.errorRate.enabled && shouldFail(p.errorRate.pct)) {
      span?.setAttributes({ 'lab.pathology': 'errorRate', 'error.injected': true });
      span?.setStatus({ code: SpanStatusCode.ERROR, message: 'injected failure' });
      req.log.error({ pathology: 'errorRate' }, 'injected failure');
      return reply.code(500).send({ error: 'injected failure', pathology: 'errorRate' });
    }

    if (p.cpuBurn.enabled) {
      burnCpu(p.cpuBurn.ms);
      applied.push('cpuBurn');
    }

    if (p.memLeak.enabled) {
      leakMemory(p.memLeak.kbPerRequest, p.memLeak.mode);
      applied.push('memLeak');
    }

    if (p.slow.enabled && url.startsWith(p.slow.route)) {
      await sleep(p.slow.ms);
      applied.push('slow');
    }

    if (applied.length > 0) {
      // Stamping the span means that six months from now, looking at a slow
      // trace, you can tell it was the lab and not a real regression.
      span?.setAttribute('lab.pathologies', applied.join(','));
    }
  });

  // Make sure unhandled errors are both logged (with trace_id, via the mixin)
  // and marked on the span, so the trace turns red in Tempo.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const span = trace.getActiveSpan();
    span?.recordException(err);
    span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    req.log.error({ err, url: req.url }, 'request failed');
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  app.register(healthRoutes);
  app.register(adminRoutes);
  app.register(productRoutes);
  app.register(orderRoutes);
  app.register(checkoutRoutes);

  return app;
}
