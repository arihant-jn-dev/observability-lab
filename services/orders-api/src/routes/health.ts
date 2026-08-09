import type { FastifyInstance } from 'fastify';
import { pool } from '../db';
import { redis } from '../cache';

/**
 * Two different questions, deliberately kept separate:
 *
 *   /health  -- "is this process alive?"  Never touches dependencies.
 *   /ready   -- "can this process serve traffic?"  Checks dependencies.
 *
 * Conflating them is a classic self-inflicted outage: if your liveness probe
 * checks the database, then a brief database blip causes the orchestrator to
 * kill every healthy app instance simultaneously, turning a degraded system
 * into a dead one.
 */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok', pid: process.pid }));

  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;

    try {
      await pool.query('SELECT 1');
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = (err as Error).message;
      ready = false;
    }

    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch (err) {
      // Redis is a cache, not a source of truth -- degraded, but still ready.
      checks.redis = `degraded: ${(err as Error).message}`;
    }

    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });
}
