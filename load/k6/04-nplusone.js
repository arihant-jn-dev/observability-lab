/**
 * PATHOLOGY: nPlusOne  —  the failure metrics CANNOT see
 *
 *   docker compose run --rm k6 run /scripts/04-nplusone.js
 *
 * Timeline: 60s healthy -> 180s with N+1 on /orders -> heal
 *
 * THE POINT: this is the exercise that justifies tracing existing at all.
 *
 * WHAT STAYS COMPLETELY NORMAL:
 *   - error rate: 0%. Every response is a correct 200.
 *   - db query duration p99: FLAT. Each of the 50 queries is sub-millisecond
 *     and index-backed (we indexed order_items.order_id on purpose).
 *   - Postgres slow query log: EMPTY. We set log_min_duration_statement=200ms
 *     and nothing comes close.
 *   - CPU: barely moves.
 *
 * WHAT CHANGES:
 *   - /orders latency rises.
 *   - "queries/sec" on the USE dashboard jumps ~25x.
 *   - pg tup_returned climbs.
 *
 * So the damage is entirely in the COUNT of round trips, not the duration of
 * any one. Every duration-based tool is blind to it. Now open a trace of
 * GET /orders and the cause is unmissable: fifty identical
 * `pg.query:SELECT ordersdb` spans marching down the screen in a staircase.
 *
 * You can also confirm it without any tooling at all -- the endpoint returns
 * its own query count:
 *     curl -s 'localhost:8080/orders?limit=50' | jq .queryCount
 *   healthy: 2      N+1: 51
 *
 * THE GENERAL LESSON: metrics answer "how much / how often". They cannot answer
 * "what shape was this request". Anything whose damage is structural rather
 * than statistical needs a trace.
 */
import { sleep } from 'k6';
import { listOrders, getProducts, setPathology, heal } from './lib.js';

export const options = {
  scenarios: {
    load: { executor: 'constant-vus', vus: 8, duration: '4m', exec: 'load' },
    controller: {
      executor: 'shared-iterations',
      vus: 1, iterations: 1, exec: 'controller', maxDuration: '4m',
    },
  },
};

export function load() {
  // Weighted toward /orders, which is where the N+1 lives.
  listOrders(50);
  if (Math.random() < 0.3) getProducts(20);
  sleep(0.3);
}

export function controller() {
  heal();
  console.log('[0:00] baseline — note "queries/sec" on the USE dashboard');
  sleep(60);

  console.log('[1:00] >>> nPlusOne ON: 1 query becomes 51 <<<');
  console.log('        watch queries/sec, NOT query duration');
  setPathology({ nPlusOne: { enabled: true } });
  sleep(180);

  console.log('[4:00] healing');
  heal();
}

export function teardown() {
  heal();
}
