/**
 * PATHOLOGY: slow  —  "the site is slow"
 *
 *   docker compose run --rm k6 run /scripts/02-slow.js
 *
 * Timeline: 60s healthy -> 180s with /products +900ms -> heal
 *
 * THE POINT: the slowness is scoped to ONE ROUTE. The service-wide p99 will
 * rise, but only /products is actually affected. Your job is to find that out
 * from the graphs rather than being told.
 *
 * WHAT TO SEE:
 *   1. RED dashboard, "Latency percentiles": p50 AND p99 both step up. Both
 *      moving together means a general slowdown of a whole population, not a
 *      slow tail.
 *   2. "p99 by route": only /products moves. THIS is the panel that localises it.
 *   3. "Latency distribution" heatmap: the band shifts up as a block. Compare
 *      this with the errorRate exercise, where the distribution splits in two.
 *   4. Click an exemplar on the /products p99 line -> the trace shows a long
 *      span with NO slow child. Nothing is being waited on; time is just being
 *      spent. That shape means the delay is in your own handler, not a
 *      dependency.
 *
 * CONTRAST WITH: 06-slow-dependency.js, where the trace has an obvious slow
 * child in another service. Same symptom on the graph, completely different
 * cause, and the trace is what tells them apart.
 */
import { sleep } from 'k6';
import { browseAndBuy, setPathology, heal } from './lib.js';

export const options = {
  scenarios: {
    load: { executor: 'constant-vus', vus: 10, duration: '4m', exec: 'load' },
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
  console.log('[0:00] baseline — note p50/p99 on the RED dashboard');
  sleep(60);

  console.log('[1:00] >>> slow ON: /products +900ms <<<');
  setPathology({ slow: { enabled: true, ms: 900, route: '/products' } });
  sleep(180);

  console.log('[4:00] healing');
  heal();
}

export function teardown() {
  heal();
}
