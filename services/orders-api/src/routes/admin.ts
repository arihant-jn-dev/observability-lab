import type { FastifyInstance } from 'fastify';
import {
  getPathologies,
  updatePathologies,
  resetPathologies,
  leakStats,
  releaseLeak,
  type PathologyState,
} from '../pathologies';
import { redis } from '../cache';
import { logger } from '../logger';

/**
 * The control panel.
 *
 * Everything here is intentionally unauthenticated and intentionally dangerous.
 * It exists only because this is a lab bound to localhost. Do not copy this
 * pattern anywhere real.
 *
 * NOTE: the pathology hook in server.ts explicitly SKIPS /admin routes. If it
 * did not, enabling `errorRate: 100` would also break the endpoint you need in
 * order to turn it back off, and your only recovery would be a restart -- which
 * would also wipe the memory leak and metrics you were trying to study.
 */
/**
 * Deliberately reports heap and off-heap separately.
 *
 * With memLeak mode='buffer' you will see `rssMb` and `externalMb` climb while
 * `heapUsedMb` stays flat -- the leak is entirely outside the V8 heap. With
 * mode='heap' the heap climbs too. Watching the same "leak" show up in
 * different metrics is the point of having both modes.
 */
function memorySnapshot() {
  const m = process.memoryUsage();
  const mb = (n: number) => +(n / 1024 / 1024).toFixed(1);
  return {
    ...leakStats(),
    rssMb: mb(m.rss),               // total physical memory, what cAdvisor sees
    heapUsedMb: mb(m.heapUsed),     // V8 heap only -- misses Buffer leaks
    heapTotalMb: mb(m.heapTotal),
    externalMb: mb(m.external),     // off-heap: Buffers, ArrayBuffers
  };
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/pathologies', async () => ({
    pathologies: getPathologies(),
    memory: memorySnapshot(),
  }));

  /**
   * Shallow-merges, so you can send just the field you want to change:
   *   curl -XPOST .../admin/pathologies -d '{"slow":{"enabled":true,"ms":2000}}'
   */
  app.post<{ Body: Partial<PathologyState> }>('/admin/pathologies', async (req) => {
    const updated = updatePathologies(req.body ?? {});
    logger.warn({ pathologies: updated }, 'pathologies updated');
    return { pathologies: updated };
  });

  app.post('/admin/pathologies/reset', async () => {
    const reset = resetPathologies();
    logger.warn('pathologies reset to defaults, leaked memory released');
    return { pathologies: reset };
  });

  /**
   * `flushCache` is an ACTION, not a state -- which is why it is a separate
   * endpoint rather than a toggle. You cannot "be flushing"; you flush once,
   * and then you watch what a cold cache does to the database underneath it.
   */
  app.post('/admin/cache/flush', async () => {
    const before = await redis.dbsize();
    await redis.flushdb();
    logger.warn({ keysEvicted: before }, 'CACHE FLUSHED under load');
    return { flushed: true, keysEvicted: before };
  });

  app.get('/admin/cache/stats', async () => {
    const info = await redis.info('stats');
    const hits = /keyspace_hits:(\d+)/.exec(info)?.[1] ?? '0';
    const misses = /keyspace_misses:(\d+)/.exec(info)?.[1] ?? '0';
    return {
      keys: await redis.dbsize(),
      keyspaceHits: Number(hits),
      keyspaceMisses: Number(misses),
    };
  });

  /** Free the leak without restarting, so RSS drop is visible in the graph. */
  app.post('/admin/memory/release', async () => {
    const { freedChunks } = releaseLeak();
    // Requires --expose-gc (set via NODE_OPTIONS in docker-compose.yml).
    // Without it the objects are unreachable but RSS stays high until V8
    // decides to collect on its own.
    if (global.gc) global.gc();
    return { freedChunks, memory: memorySnapshot() };
  });
}
