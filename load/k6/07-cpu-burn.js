/**
 * PATHOLOGY: cpuBurn  —  CPU vs queueing vs slow dependency
 *
 *   docker compose run --rm k6 run /scripts/07-cpu-burn.js
 *
 * Timeline: 60s healthy -> 180s burning 200ms of CPU per request -> heal
 *
 * THE POINT: three very different problems all present as "latency is up".
 * This exercise teaches the fingerprint that separates them.
 *
 *   CPU-BOUND (this one)
 *     container CPU: HIGH
 *     event loop delay p99: HIGH
 *     DB / cache metrics: idle
 *     trace: long span, no slow children, no gaps
 *     -> the work is ours and it is real work
 *
 *   QUEUEING (05-flush-cache.js, once the pool saturates)
 *     container CPU: LOW
 *     db_pool_connections{state="waiting"}: > 0
 *     trace: a GAP before the DB span starts
 *     -> nobody is busy; we are waiting for a slot
 *
 *   SLOW DEPENDENCY (06-slow-dependency.js)
 *     container CPU: LOW
 *     event loop delay: normal
 *     trace: long CHILD span owned by another service
 *     -> the time is someone else's
 *
 * Low CPU with high latency is the most informative combination in that table,
 * because it rules out "we need bigger machines" -- the answer people reach for
 * first and the one that would waste money here.
 *
 * NODE-SPECIFIC, and important: cpuBurn blocks the EVENT LOOP. That means
 * requests doing no work at all get slow too, because they cannot even be
 * picked up. Watch /products degrade while it does nothing expensive. In Node,
 * one hot endpoint degrades every endpoint in the process -- which is why
 * "event loop delay" belongs on your dashboard next to CPU, not instead of it.
 */
import { sleep } from 'k6';
import { browseAndBuy, setPathology, heal } from './lib.js';

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
  browseAndBuy();
  sleep(0.2);
}

export function controller() {
  heal();
  console.log('[0:00] baseline — note container CPU and event loop delay');
  sleep(60);

  console.log('[1:00] >>> cpuBurn ON: 200ms of real CPU per request <<<');
  console.log('        watch: CPU up, event loop delay up, DB/cache IDLE');
  setPathology({ cpuBurn: { enabled: true, ms: 200 } });
  sleep(180);

  console.log('[4:00] healing');
  heal();
}

export function teardown() {
  heal();
}
