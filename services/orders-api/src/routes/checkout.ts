import type { FastifyInstance } from 'fastify';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { pool } from '../db';
import { config } from '../config';
import { getPathologies } from '../pathologies';
import { ordersCreated, ordersFailed, orderValue } from '../metrics';
import { enqueueOrderJob } from '../queue';
import { logger } from '../logger';

/**
 * The distributed path: orders-api -> payments-api over HTTP.
 *
 * `slowDependency` does NOT sleep here. It asks payments-api to be slow, via a
 * header. That distinction is the whole point: when you open the resulting
 * trace you will see orders-api's span is long *because* a child span belonging
 * to a different service is long. The blame is visible and unambiguous.
 *
 * If we had just slept locally, the trace would show orders-api being slow for
 * no visible reason -- which is exactly what an UNinstrumented dependency looks
 * like, and exactly the ambiguity tracing exists to remove.
 */
export async function checkoutRoutes(app: FastifyInstance) {
  app.post<{ Body: { customerId?: number; amountCents?: number } }>(
    '/checkout',
    async (req, reply) => {
      const span = trace.getActiveSpan();
      const customerId = req.body?.customerId ?? 1 + Math.floor(Math.random() * 200);
      const amountCents = req.body?.amountCents ?? 1000 + Math.floor(Math.random() * 20000);
      const { slowDependency } = getPathologies();

      const { rows } = await pool.query(
        `INSERT INTO orders (customer_id, status, total_cents)
         VALUES ($1, 'pending', $2) RETURNING id`,
        [customerId, amountCents],
      );
      const orderId = rows[0].id as number;

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (slowDependency.enabled) {
        headers['x-simulate-delay-ms'] = String(slowDependency.ms);
      }

      let paymentStatus = 'failed';
      try {
        // Plain fetch -- auto-instrumentation (undici) creates the client span
        // AND injects the `traceparent` header so payments-api joins this trace.
        // You wrote no propagation code for this; over HTTP it is free.
        const res = await fetch(`${config.paymentsUrl}/authorize`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ orderId, amountCents, customerId }),
          // Without a timeout, a 5s dependency becomes a 5s outage for you.
          // Raise/lower this to feel the difference between "slow" and "shed".
          signal: AbortSignal.timeout(Number(process.env.PAYMENTS_TIMEOUT_MS ?? 10_000)),
        });

        const body = (await res.json()) as { approved?: boolean; authId?: string };
        paymentStatus = res.ok && body.approved ? 'paid' : 'failed';

        span?.setAttributes({
          'payment.approved': Boolean(body.approved),
          'payment.auth_id': body.authId ?? 'none',
        });
      } catch (err) {
        // A dependency timeout is OUR error to the caller, even though it is
        // someone else's fault. Record it as such on the span.
        span?.recordException(err as Error);
        span?.setStatus({ code: SpanStatusCode.ERROR, message: 'payment call failed' });
        logger.error({ err, orderId }, 'payment dependency failed');
        paymentStatus = 'failed';
      }

      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [paymentStatus, orderId]);

      if (paymentStatus === 'paid') {
        ordersCreated.add(1, { status: 'paid' });
        orderValue.record(amountCents / 100, { currency: 'USD' });
        await enqueueOrderJob({ orderId, customerId, totalCents: amountCents });
      } else {
        ordersFailed.add(1, { reason: 'payment_declined' });
      }

      span?.setAttributes({ 'order.id': orderId, 'order.status': paymentStatus });

      return reply
        .code(paymentStatus === 'paid' ? 201 : 402)
        .send({ orderId, status: paymentStatus, amountCents });
    },
  );
}
