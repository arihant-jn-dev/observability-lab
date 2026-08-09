# The metric cardinality trap

How to take down your monitoring system with your own instrumentation — and
why the instinct that causes it feels so reasonable.

---

## The mechanism

Every **distinct combination of label values** is a separate time series that
Prometheus stores, indexes, and holds in memory.

```
http_requests_total{route="/products", status="200"}   → series 1
http_requests_total{route="/products", status="500"}   → series 2
http_requests_total{route="/orders",   status="200"}   → series 3
```

3 routes × 5 status codes = 15 series. Fine.

Now add `user_id`:

```
http_requests_total{route="/products", status="200", user_id="8814"}
```

3 × 5 × **200,000 users** = 3,000,000 series. From one label.

And it is worse than the arithmetic suggests:

- Series persist **long after** the label stops being emitted — they stay in the
  head block until it is cut. Deleting the bad code does not give you your
  memory back.
- It degrades **everything**, not just the offending metric. Ingestion and query
  planning slow down for every dashboard you own.
- The blast radius is your *monitoring*, which is what you need most during the
  incident it causes.

---

## It already happened in this lab — twice

### 1. Accidentally, in this very build

While wiring up the collector, `resource_to_telemetry_conversion` promoted
**every** OTel resource attribute into a Prometheus label. Measured on the
running stack:

```
biggest label values by memory:
  process_command_args         211456 bytes   ← the entire argv array, as a label
  __name__                     100612 bytes
  instance                      54954 bytes
  process_executable_name       51920 bytes
  process_executable_path       51920 bytes
```

`process_command_args` — the full Node argv, including every tsx loader flag —
was the **single largest label in the database**. And `process_pid` and
`host_name` change on **every container restart**, so each `docker compose up`
abandoned the old series and created a fresh set. A slow leak that a
long-running system eventually dies from.

Nobody wrote `process.command_args` anywhere. A default resource detector added
it, and one config flag promoted it to a label. **This is the normal way
cardinality problems arrive: not from a bad decision, but from a default.**

The fix is the `resource/trim` processor in
[the collector config](../observability/otel-collector/config.yaml) — an explicit
allowlist mindset, deleting everything that is not something you would group or
filter by. Result: **19 labels per series → 9.**

### 2. Deliberately, for you to detonate

```bash
docker compose run --rm k6 run /scripts/09-cardinality-bomb.js
```

The offending code, in [orders.ts](../services/orders-api/src/routes/orders.ts):

```ts
cardinalityBomb.add(1, {
  order_id: String(orderId),        // ← unbounded: one new series per order
  customer_id: String(customerId),
});
```

Watch it climb:

```bash
watch -n5 'curl -s localhost:9090/api/v1/status/tsdb \
  | python3 -c "import sys,json;print(json.load(sys.stdin)[\"data\"][\"headStats\"][\"numSeries\"])"'
```

Then switch it off and watch the series count **stay high**. That persistence is
the lesson.

Clean up: `docker compose restart prometheus`

---

## Finding the culprit

The query to memorise:

```promql
# which metric names have the most series?
topk(10, count by (__name__)({__name__=~".+"}))
```

```promql
# total active series
prometheus_tsdb_head_series

# which label values are eating memory (via the API)
curl -s localhost:9090/api/v1/status/tsdb | python3 -m json.tool
```

```promql
# how many distinct values does one label have on one metric?
count(count by (customer_id) (cardinality_bomb_total))
```

There is a standing alert for this — `PrometheusCardinalityGrowing` in
[alerts.yml](../observability/prometheus/rules/alerts.yml). Monitoring your
monitoring is not paranoia; this failure mode is common enough to deserve it.

---

## The rule, and the escape hatch

**Metric labels must be bounded and small.**

| Safe as a label | Never as a label |
|---|---|
| route **template** (`/orders/:id`) | raw URL (`/orders/8814`) |
| status code | user id, order id, session id, request id |
| service, region, environment | email, IP address |
| error *class* | error *message* |
| queue name | full SQL text |

Rule of thumb: if you cannot write down the complete list of possible values,
it does not belong in a metric label.

### The escape hatch — and this is the important part

High-cardinality data is exactly what **traces and logs are for**.

```ts
// ✗ metric label — creates a series per order, forever
cardinalityBomb.add(1, { order_id: String(orderId) });

// ✓ span attribute — stored per event, costs nothing extra
trace.getActiveSpan()?.setAttributes({ 'order.id': orderId });

// ✓ log field — stored per line, searchable via trace_id
logger.info({ orderId, customerId }, 'order created');
```

All three appear in this codebase, deliberately. The real routes in
[products.ts](../services/orders-api/src/routes/products.ts) put `cache.key` and
`product.category` on the **span** while keeping the metric label to
`result=hit|miss` — two bounded values.

> **Metrics = aggregates → must be bounded.
> Traces & logs = individual events → unbounded is fine.**

Nearly every cardinality disaster is someone trying to make metrics do a
trace's job. When you feel the urge to add a label so you can debug one
customer's problem, that urge is correct — it is just pointing at the wrong
signal.

---

## The same trap in Loki

It generalises. In Loki, **labels are the index**, and each unique combination
is a *stream*:

```alloy
// ✓ bounded — these are what you filter by
stage.labels {
  values = { level = "", service = "", role = "" }
}

// ✓ unbounded — stored WITH the line, not in the index
stage.structured_metadata {
  values = { trace_id = "" }
}
```

`trace_id` as a Loki label would create one stream per request. As structured
metadata it is queryable (`| trace_id = "abc..."`) and costs nothing in the
index. Verified working in this lab — that exact query returns the 3 log lines
for one request, across two processes.

Same principle, different database: **high-cardinality identifiers attach to
individual events, never to the aggregate/index dimension.**

---

Related: [03-signals.md](03-signals.md) ·
[09-cardinality-bomb.js](../load/k6/09-cardinality-bomb.js)
