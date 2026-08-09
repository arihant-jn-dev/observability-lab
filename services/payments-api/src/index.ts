// ⚠️  MUST BE FIRST.
import './otel';

import Fastify from 'fastify';
import pino from 'pino';
import { context, trace } from '@opentelemetry/api';

/**
 * A stand-in "third party payment gateway".
 *
 * It exists so that the lab has a real cross-process trace. Its only
 * interesting behaviour is that it will be as slow as you ask it to be, via the
 * `x-simulate-delay-ms` header that orders-api sets when the `slowDependency`
 * pathology is on.
 *
 * The reason the delay lives HERE rather than in orders-api is pedagogical:
 * it makes the trace waterfall assign blame correctly. You will see orders-api
 * waiting on a child span owned by a different service.
 */
const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.OTEL_SERVICE_NAME ?? 'payments-api', role: 'api' },
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const sc = span.spanContext();
    return sc.traceId ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
  },
});

const app = Fastify({ loggerInstance: logger });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.get('/health', async () => ({ status: 'ok' }));

app.post<{
  Body: { orderId?: number; amountCents?: number; customerId?: number };
  Headers: { 'x-simulate-delay-ms'?: string };
}>('/authorize', async (req, reply) => {
  const delayMs = Number(req.headers['x-simulate-delay-ms'] ?? 0);
  const { orderId, amountCents = 0 } = req.body ?? {};
  const span = trace.getActiveSpan();

  if (delayMs > 0) {
    span?.setAttribute('payment.simulated_delay_ms', delayMs);
    // This sleep is the "slow dependency". In the trace it appears as time
    // spent inside payments-api, not inside orders-api. That is the point.
    await sleep(delayMs);
  } else {
    await sleep(15 + Math.random() * 40); // normal gateway latency
  }

  // Decline very large amounts, so there is a non-injected, *legitimate*
  // source of 402s in the data. Not every non-200 is a bug -- learning to tell
  // "expected failure" from "incident" is half of alerting.
  const approved = amountCents < 500_000;
  const authId = `auth_${Math.random().toString(36).slice(2, 10)}`;

  span?.setAttributes({
    'payment.approved': approved,
    'payment.amount_cents': amountCents,
  });

  logger.info({ orderId, amountCents, approved, delayMs }, 'authorization processed');

  return reply.code(approved ? 200 : 402).send({
    approved,
    authId: approved ? authId : null,
    reason: approved ? null : 'amount_exceeds_limit',
  });
});

const port = Number(process.env.PORT ?? 8081);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => logger.info({ port }, 'payments-api listening'))
  .catch((err) => {
    logger.fatal({ err }, 'failed to start');
    process.exit(1);
  });
