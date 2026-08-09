/**
 * PATHOLOGY: slowDependency  —  your latency, someone else's fault
 *
 *   docker compose run --rm k6 run /scripts/06-slow-dependency.js
 *
 * Timeline: 60s healthy -> 180s with payments-api at 5s -> heal
 *
 * THE POINT: from the outside this looks IDENTICAL to 02-slow.js. Same
 * symptom, same graph shape: p99 on one route goes through the roof. The
 * distinction is only visible in a trace.
 *
 *   02-slow.js       trace = one long span, NO slow children.
 *                    Time is being spent by US.
 *
 *   this scenario    trace = one long span whose child span belongs to
 *                    payments-api and accounts for ~all the time.
 *                    Time is being spent by THEM.
 *
 * The fix for those two situations shares nothing. Guessing between them is how
 * teams spend a week optimising code that was never the problem.
 *
 * ALSO WATCH — USE dashboard, "Outbound call latency":
 *   Two lines are plotted deliberately: client-side (what orders-api waits) and
 *   server-side (what payments-api actually spends). Here they move TOGETHER,
 *   which means the dependency really is slow. If the client line rose while
 *   the server line stayed flat, the time would be going into the network or
 *   your own connection pool -- their service would be innocent.
 *   Having both sides is what makes that distinguishable at all.
 *
 * THE SECOND-ORDER LESSON — watch /products, which does not call payments-api:
 *   Its latency degrades too, because slow /checkout requests occupy VUs and
 *   connections. A slow dependency on ONE route can consume shared resources
 *   and drag down routes that never touch it. This is why timeouts and
 *   bulkheads exist. Try setting PAYMENTS_TIMEOUT_MS=1000 in docker-compose.yml
 *   and re-running: you trade some failed checkouts for a service that stays up.
 */
import { sleep } from 'k6';
import { checkout, getProducts, setPathology, heal } from './lib.js';

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
  checkout();
  getProducts(20);
  sleep(0.2);
}

export function controller() {
  heal();
  console.log('[0:00] baseline — /checkout p99 should be well under 100ms');
  sleep(60);

  console.log('[1:00] >>> slowDependency ON: payments-api now takes 5s <<<');
  console.log('        open a /checkout trace and see WHOSE span is long');
  setPathology({ slowDependency: { enabled: true, ms: 5000 } });
  sleep(180);

  console.log('[4:00] healing');
  heal();
}

export function teardown() {
  heal();
}
