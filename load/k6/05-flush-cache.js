/**
 * ACTION: flushCache  —  when losing a PERFORMANCE component causes an
 *                        AVAILABILITY failure
 *
 *   docker compose run --rm k6 run /scripts/05-flush-cache.js
 *
 * Timeline: 90s warm cache -> FLUSH -> 150s cold, under the same load -> heal
 *
 * THE POINT: Redis is "just a cache". Every read path falls back to Postgres,
 * so losing it should be survivable. That reasoning is correct in isolation and
 * wrong at scale, and this exercise shows exactly why.
 *
 * THE MECHANISM: while warm, the cache absorbs ~95% of reads, so Postgres sees
 * ~5% of read traffic and looks massively over-provisioned. Empty the cache and
 * 100% of reads arrive at a database sized for 5% of them. Nothing failed.
 * Nothing errored. The system still degrades from "fast" to "unusable".
 *
 * WHAT TO WATCH, at the moment of the flush (in causal order):
 *   1. RED "Cache hit ratio" -> falls off a cliff. LEADING indicator.
 *   2. USE "Database query duration", 2nd line -> queries/sec jumps
 *      (measured on this stack: ~0.3/s -> ~79/s).
 *   3. USE "Postgres: rows fetched vs returned" -> tup_returned climbs.
 *   4. RED "Latency percentiles" -> p99 rises modestly.
 *      Measured per-request: cache HIT ~2.4ms, cache MISS ~12.6ms.
 *
 * BE HONEST ABOUT WHAT YOU WILL *NOT* SEE:
 *   The connection pool does NOT saturate here and p99 does NOT blow out.
 *   Verified repeatedly, including with PG_POOL_MAX=3 and 30 concurrent
 *   readers: db_pool_connections{state="waiting"} stays at 0.
 *
 *   The arithmetic: 10 connections / 17.5ms per query = ~570 queries/sec
 *   before anything queues. The flush produces ~79/s. Not close.
 *
 *   And there are only ~500 distinct cache keys, so the cache refills in
 *   about ONE SECOND. Prometheus scrapes every TEN. The most violent moment
 *   of this incident is invisible to your metrics -- which is a real lesson
 *   in itself. See docs/exercises/04-flush-cache.md for why this same
 *   mechanism DOES take real systems down, and how to make it hurt here.
 *
 * Note the ORDER of the chain: cache -> DB load -> (at scale) pool saturation
 * -> latency. If you only had the latency graph you would be at the END of
 * that chain with no idea where it started. This is why USE dashboards exist
 * alongside RED ones.
 *
 * THE GENERAL LESSON: "it's only a cache" is a statement about correctness, not
 * about capacity. Any component absorbing most of your load is load-bearing,
 * whatever the architecture diagram calls it. Ask of every cache: what happens
 * to the thing behind it if this empties at peak?
 */
import { sleep } from 'k6';
import { getProducts, getProduct, flushCache, heal } from './lib.js';

export const options = {
  scenarios: {
    // Heavier read load -- the whole point is to overwhelm what the cache was
    // protecting, so the DB must actually feel it.
    load: { executor: 'constant-vus', vus: 25, duration: '4m', exec: 'load' },
    controller: {
      executor: 'shared-iterations',
      vus: 1, iterations: 1, exec: 'controller', maxDuration: '4m',
    },
  },
};

export function load() {
  getProducts(50);
  getProduct(1 + Math.floor(Math.random() * 500));
  sleep(0.1);
}

export function controller() {
  heal();
  console.log('[0:00] warming the cache — watch hit ratio climb toward 1.0');
  sleep(90);

  console.log('[1:30] >>> FLUSHING REDIS under full load <<<');
  const res = flushCache();
  console.log(`        evicted: ${res.body}`);
  console.log('        now watch, IN ORDER: hit ratio -> pg blks_read -> pool waiting -> p99');
  sleep(150);

  console.log('[4:00] done — the cache refills on its own');
  heal();
}

export function teardown() {
  heal();
}
