import { Pool } from 'pg';
import { config } from './config';
import { logger } from './logger';

/**
 * A deliberately SMALL connection pool.
 *
 * max:10 is not a mistake to be fixed -- it is the queueing lesson. Once
 * concurrent requests exceed 10, requests do not fail and Postgres does not get
 * slower; requests simply *wait* for a free connection. That wait is invisible
 * in database metrics (the DB looks fine!) and invisible in CPU metrics (nobody
 * is busy). It shows up only as a gap in the trace, or in `pool_wait_seconds`
 * below. This is the single most commonly misdiagnosed shape of "slow".
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected postgres pool error');
});

export async function waitForDb(retries = 30): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      logger.info('postgres ready');
      return;
    } catch (err) {
      logger.warn({ attempt, err: (err as Error).message }, 'waiting for postgres');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('postgres never became ready');
}

/** Pool saturation snapshot -- exported as a metric in metrics.ts. */
export function poolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount, // >0 means requests are queueing for a connection
  };
}
