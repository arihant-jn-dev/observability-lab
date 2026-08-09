/**
 * BASELINE — run this first, and run it before every other scenario.
 *
 * You cannot recognise "abnormal" without having looked at "normal". Most
 * people skip this step and then spend an incident arguing about whether 180ms
 * is bad. Ten minutes of baseline answers that permanently.
 *
 *   docker compose run --rm k6 run /scripts/01-baseline.js
 *
 * WHAT TO WRITE DOWN while this runs (RED dashboard):
 *   - requests/sec per route
 *   - p50 and p99 for each route
 *   - cache hit ratio once warm
 *   - queue lag p99
 *
 * Those five numbers are your reference for every exercise that follows.
 */
import { sleep } from 'k6';
import { browseAndBuy, heal } from './lib.js';

export const options = {
  scenarios: {
    load: { executor: 'constant-vus', vus: 10, duration: '3m', exec: 'load' },
  },
  thresholds: {
    // A healthy system should comfortably beat these. If the baseline itself
    // fails these, something is already wrong -- fix that before continuing.
    'http_req_failed{admin:false}': ['rate<0.01'],
    'http_req_duration{name:GET /products}': ['p(99)<500'],
  },
};

export function setup() {
  heal();
  sleep(2);
}

export function load() {
  browseAndBuy();
  sleep(0.2);
}

export function teardown() {
  heal();
}
