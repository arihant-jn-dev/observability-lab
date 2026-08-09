import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';

/**
 * Redis is used here as a *performance* component, not a *correctness* one:
 * every read path falls back to Postgres on a miss. Losing Redis should
 * therefore be survivable.
 *
 * The `flushCache` exercise exists to show that this reasoning is wrong at
 * scale. A cache that absorbs 95% of reads is load-bearing infrastructure; when
 * it empties under load, 100% of reads hit a database sized for 5% of them.
 * The system degrades from "fast" to "down" without any component actually
 * failing.
 */
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 2,
  // Don't let a Redis outage hang requests forever -- fail fast to Postgres.
  connectTimeout: 2000,
  lazyConnect: false,
});

redis.on('error', (err) => {
  logger.warn({ err: err.message }, 'redis error');
});

export async function waitForRedis(retries = 30): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await redis.ping();
      logger.info('redis ready');
      return;
    } catch (err) {
      logger.warn({ attempt, err: (err as Error).message }, 'waiting for redis');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('redis never became ready');
}

/**
 * Read-through cache helper.
 *
 * Returns the value plus whether it was a hit, so callers can record the
 * cache_operations_total metric. Hit ratio is one of the few ratios worth
 * alerting on -- not because a low ratio is itself bad, but because a *sudden
 * drop* is the leading indicator of a database about to fall over.
 */
export async function readThrough<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      return { value: JSON.parse(cached) as T, hit: true };
    }
  } catch (err) {
    // Cache read failed -> degrade to the database rather than erroring.
    logger.warn({ key, err: (err as Error).message }, 'cache read failed, falling through');
  }

  const value = await loader();

  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ key, err: (err as Error).message }, 'cache write failed');
  }

  return { value, hit: false };
}
