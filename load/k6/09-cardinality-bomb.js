/**
 * PATHOLOGY: cardinalityBomb  —  taking down your monitoring with your own
 *                                instrumentation
 *
 *   docker compose run --rm k6 run /scripts/09-cardinality-bomb.js
 *
 * ⚠️  This one deliberately damages Prometheus. It is safe here because
 *     retention is 6h and you can `docker compose restart prometheus`, but
 *     understand what you are doing before running it.
 *
 * Timeline: 30s healthy -> 180s creating orders with an unbounded metric label
 *
 * THE POINT: every distinct combination of label values is a SEPARATE TIME
 * SERIES that Prometheus stores, indexes, and holds in memory. Attach something
 * unbounded -- an order id, a user id, a request id, a raw URL with ids in it --
 * and you create one series per event, forever.
 *
 * The offending code is in services/orders-api/src/routes/orders.ts:
 *
 *     cardinalityBomb.add(1, {
 *       order_id: String(orderId),        // <-- unbounded
 *       customer_id: String(customerId),
 *     });
 *
 * WATCH IT HAPPEN:
 *     watch -n5 'curl -s localhost:9090/api/v1/status/tsdb \
 *       | python3 -c "import sys,json;print(json.load(sys.stdin)[\"data\"][\"headStats\"][\"numSeries\"])"'
 *
 * FIND THE CULPRIT (the query to remember):
 *     topk(10, count by (__name__)({__name__=~".+"}))
 *
 * WHY IT IS SO DANGEROUS:
 *   - Series are held in memory until they age out of the head block. Deleting
 *     the bad code does NOT free them immediately.
 *   - It degrades EVERYTHING, not just the bad metric. Query planning and
 *     ingestion slow for every dashboard you own.
 *   - It usually ships as a one-line "improvement" -- "let's label by customer
 *     so we can debug per-customer issues" -- which sounds helpful in review.
 *
 * THE RULE:
 *     Metric labels must be BOUNDED and small. Route templates, status codes,
 *     service names, regions: yes. Anything with an id in it: no.
 *
 * THE ESCAPE HATCH, and the thing worth internalising:
 *     High-cardinality data is exactly what TRACES and LOGS are for. Traces
 *     store per-event, so span attributes can carry order_id, customer_id,
 *     anything. Loki stores trace_id as structured metadata, not as a label,
 *     for the same reason.
 *
 *     Metrics = aggregates, must be bounded.
 *     Traces/logs = individual events, unbounded is fine.
 *
 *     Nearly every cardinality disaster is someone trying to make metrics do a
 *     trace's job. See docs/04-cardinality.md.
 *
 * CLEAN UP:
 *     docker compose restart prometheus     # drops the head block
 */
import { sleep } from 'k6';
import { createOrder, setPathology, heal } from './lib.js';

export const options = {
  scenarios: {
    load: { executor: 'constant-vus', vus: 15, duration: '3m30s', exec: 'load' },
    controller: {
      executor: 'shared-iterations',
      vus: 1, iterations: 1, exec: 'controller', maxDuration: '3m30s',
    },
  },
};

export function load() {
  createOrder();
  sleep(0.05);
}

export function controller() {
  console.log('[0:00] baseline — record the current series count first:');
  console.log('        curl -s localhost:9090/api/v1/status/tsdb');
  heal();
  sleep(30);

  console.log('[0:30] >>> cardinalityBomb ON — one new series per order <<<');
  setPathology({ cardinalityBomb: { enabled: true } });
  sleep(180);

  console.log('[3:30] switching off — but the series DO NOT disappear.');
  console.log('        That persistence is the whole lesson.');
  console.log('        Clean up with: docker compose restart prometheus');
  heal();
}

export function teardown() {
  heal();
}
