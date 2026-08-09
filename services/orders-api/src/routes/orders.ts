import type { FastifyInstance } from 'fastify';
import { trace } from '@opentelemetry/api';
import { pool } from '../db';
import { getPathologies } from '../pathologies';
import { ordersCreated, ordersFailed, orderValue, cardinalityBomb } from '../metrics';
import { enqueueOrderJob } from '../queue';
import { logger } from '../logger';

export async function orderRoutes(app: FastifyInstance) {
  /**
   * ================= THE N+1 ENDPOINT =================
   * Both branches return byte-identical JSON. Same data, same correctness,
   * same status code. The ONLY difference is round-trip count.
   *
   * This is why N+1 is so hard to catch with metrics alone: error rate is
   * unchanged, the database reports no slow queries (each one is <1ms and
   * index-backed), CPU is flat on both sides. The single place it is glaringly
   * obvious is a trace waterfall, where you see 50 identical sequential spans
   * marching down the screen.
   * ====================================================
   */
  app.get<{ Querystring: { limit?: string } }>('/orders', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 25), 100);
    const { nPlusOne } = getPathologies();
    const span = trace.getActiveSpan();

    const { rows: orders } = await pool.query(
      `SELECT id, customer_id, status, total_cents, created_at
         FROM orders ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );

    let queryCount = 1;

    if (nPlusOne.enabled) {
      // The pathological path: one extra query PER ROW.
      for (const order of orders) {
        const { rows } = await pool.query(
          `SELECT product_id, quantity, price_cents FROM order_items WHERE order_id = $1`,
          [order.id],
        );
        order.items = rows;
        queryCount++;
      }
    } else {
      // The healthy path: one extra query TOTAL, regardless of row count.
      const ids = orders.map((o) => o.id);
      const { rows: items } = await pool.query(
        `SELECT order_id, product_id, quantity, price_cents
           FROM order_items WHERE order_id = ANY($1::int[])`,
        [ids],
      );
      queryCount++;
      const byOrder = new Map<number, unknown[]>();
      for (const item of items) {
        if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
        byOrder.get(item.order_id)!.push(item);
      }
      for (const order of orders) order.items = byOrder.get(order.id) ?? [];
    }

    span?.setAttributes({
      'db.query_count': queryCount,
      'app.n_plus_one': nPlusOne.enabled,
      'orders.returned': orders.length,
    });

    return { count: orders.length, queryCount, orders };
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });

    const { rows } = await pool.query(
      `SELECT o.id, o.status, o.total_cents, o.created_at,
              c.name AS customer_name, c.email AS customer_email, c.tier
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1`,
      [id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'order not found' });

    const { rows: items } = await pool.query(
      `SELECT oi.product_id, p.name, oi.quantity, oi.price_cents
         FROM order_items oi JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1`,
      [id],
    );

    return { order: { ...rows[0], items } };
  });

  /** Write path: insert an order, then hand async work to the worker. */
  app.post<{ Body: { customerId?: number; items?: Array<{ productId: number; quantity: number }> } }>(
    '/orders',
    async (req, reply) => {
      const customerId = req.body?.customerId ?? 1 + Math.floor(Math.random() * 200);
      const items =
        req.body?.items ??
        Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => ({
          productId: 1 + Math.floor(Math.random() * 500),
          quantity: 1 + Math.floor(Math.random() * 3),
        }));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { rows: created } = await client.query(
          `INSERT INTO orders (customer_id, status, total_cents)
           VALUES ($1, 'pending', 0) RETURNING id`,
          [customerId],
        );
        const orderId = created[0].id as number;

        let total = 0;
        for (const item of items) {
          const { rows: prod } = await client.query(
            'SELECT price_cents FROM products WHERE id = $1',
            [item.productId],
          );
          if (!prod[0]) continue;
          const price = prod[0].price_cents as number;
          total += price * item.quantity;
          await client.query(
            `INSERT INTO order_items (order_id, product_id, quantity, price_cents)
             VALUES ($1, $2, $3, $4)`,
            [orderId, item.productId, item.quantity, price],
          );
        }

        await client.query('UPDATE orders SET total_cents = $1 WHERE id = $2', [total, orderId]);
        await client.query('COMMIT');

        // --- business metrics, the part auto-instrumentation cannot know ---
        ordersCreated.add(1, { status: 'pending' });
        orderValue.record(total / 100, { currency: 'USD' });

        const { cardinalityBomb: bomb } = getPathologies();
        if (bomb.enabled) {
          // Unbounded label. One new time series per order, forever.
          cardinalityBomb.add(1, {
            order_id: String(orderId),
            customer_id: String(customerId),
          });
        }

        await enqueueOrderJob({ orderId, customerId, totalCents: total });

        trace.getActiveSpan()?.setAttributes({
          'order.id': orderId,
          'order.total_cents': total,
          'order.item_count': items.length,
        });
        logger.info({ orderId, customerId, totalCents: total }, 'order created');

        return reply.code(201).send({ orderId, totalCents: total, status: 'pending' });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        ordersFailed.add(1, { reason: 'db_error' });
        logger.error({ err }, 'order creation failed');
        throw err;
      } finally {
        client.release();
      }
    },
  );
}
