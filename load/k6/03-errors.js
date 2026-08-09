/**
 * PATHOLOGY: errorRate  —  finding the CAUSE, not the count
 *
 *   docker compose run --rm k6 run /scripts/03-errors.js
 *
 * Timeline: 60s healthy -> 180s at 30% failures -> heal
 *
 * THE POINT: a metric can tell you 30% of requests are failing. It can never
 * tell you WHY. This exercise is the full three-signal walk, and it is the
 * single most important workflow in the lab.
 *
 * DO THIS, IN ORDER:
 *   1. METRICS — RED dashboard. "Error rate" stat goes red. "Error ratio by
 *      route" shows which endpoints. You now know WHEN and WHERE.
 *      You do NOT know why. Metrics are aggregates; the reason was discarded
 *      at collection time.
 *
 *   2. TRACES — on the "p99 by route" panel, click an exemplar diamond on a
 *      failing route. You land in one specific failed request. Now you can see
 *      exactly which span errored and how far the request got.
 *
 *   3. LOGS — from that trace, click "Logs for this span". Loki filters to
 *      trace_id and you get the actual sentence:
 *        {"level":"error","msg":"injected failure","pathology":"errorRate"}
 *
 *   Metric -> which route. Trace -> which request and which step. Log -> the
 *   actual reason. No single signal could have done that alone.
 *
 * ALSO NOTICE: the alert HighErrorRate fires after 2 minutes, not instantly.
 * That delay is deliberate -- `for: 2m` is what stops a 10-second blip from
 * waking someone at 3am. Watch it go PENDING then FIRING at
 * http://localhost:9090/alerts
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
  // We EXPECT failures here, so no failure threshold -- otherwise k6 would
  // report the exercise itself as a failed test.
};

export function load() {
  browseAndBuy();
  sleep(0.2);
}

export function controller() {
  heal();
  console.log('[0:00] baseline');
  sleep(60);

  console.log('[1:00] >>> errorRate ON: 30% of requests will 500 <<<');
  setPathology({ errorRate: { enabled: true, pct: 30 } });
  sleep(180);

  console.log('[4:00] healing');
  heal();
}

export function teardown() {
  heal();
}
