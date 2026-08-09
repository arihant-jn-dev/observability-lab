import type { FastifyInstance } from 'fastify';
import { trace } from '@opentelemetry/api';
import { pool } from '../db';
import { readThrough } from '../cache';
import { config } from './../config';
import { cacheOperations } from '../metrics';

/**
 * The cached read path. This is the endpoint the `flushCache` exercise targets.
 *
 * Under normal operation almost every request here is served from Redis and
 * never touches Postgres. That makes the database look idle and over-provisioned
 * -- right up until the cache empties.
 */
export async function productRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { category?: string; limit?: string } }>(
    '/products',
    async (req) => {
      const category = req.query.category ?? 'all';
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const key = `products:list:${category}:${limit}`;

      const { value, hit } = await readThrough(key, config.cacheTtlSeconds, async () => {
        /**
         * DELIBERATELY EXPENSIVE (~17ms measured).
         *
         * This is the query the cache exists to avoid: it aggregates every row
         * in order_items (20k) to compute per-product sales figures.
         *
         * The expense is the whole point. A cache in front of a 0.5ms indexed
         * lookup is a strawman -- flushing it changes nothing measurable, and
         * you would learn the wrong lesson (that losing a cache is harmless).
         * Real caches sit in front of real work, and that is what makes them
         * load-bearing infrastructure rather than an optimisation.
         *
         * With PG_POOL_MAX=10 and ~17ms per query, this path tops out around
         * 570 queries/sec. Above that, requests QUEUE for a connection -- which
         * is exactly the cascade the flushCache exercise is built to show.
         */
        const where = category === 'all' ? '' : 'WHERE p.category = $2';
        const sql = `
          SELECT p.id, p.sku, p.name, p.category, p.price_cents, p.stock,
                 COALESCE(SUM(oi.quantity), 0)   AS units_sold,
                 COUNT(DISTINCT oi.order_id)     AS order_count
            FROM products p
            LEFT JOIN order_items oi ON oi.product_id = p.id
            ${where}
           GROUP BY p.id
           ORDER BY p.id
           LIMIT $1`;
        const params = category === 'all' ? [limit] : [limit, category];
        const { rows } = await pool.query(sql, params);
        return rows;
      });

      // Record the hit/miss. `result` is a bounded label (2 values) -- safe.
      // Note we do NOT label by `category` value from user input; see
      // docs/04-cardinality.md for why that instinct is dangerous.
      cacheOperations.add(1, { cache: 'products_list', result: hit ? 'hit' : 'miss' });

      // Span attributes are the trace-side equivalent. Unlike metric labels,
      // high-cardinality values are FINE here -- traces are stored per-event,
      // not aggregated into series. This asymmetry is the single most useful
      // thing to internalise about metrics vs traces.
      trace.getActiveSpan()?.setAttributes({
        'cache.hit': hit,
        'cache.key': key,
        'product.category': category,
      });

      return { count: (value as unknown[]).length, cacheHit: hit, products: value };
    },
  );

  app.get<{ Params: { id: string } }>('/products/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });

    const { value, hit } = await readThrough(
      `products:item:${id}`,
      config.cacheTtlSeconds,
      async () => {
        const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
        return rows[0] ?? null;
      },
    );

    cacheOperations.add(1, { cache: 'products_item', result: hit ? 'hit' : 'miss' });
    trace.getActiveSpan()?.setAttributes({ 'cache.hit': hit, 'product.id': id });

    if (!value) return reply.code(404).send({ error: 'product not found' });
    return { cacheHit: hit, product: value };
  });
}
