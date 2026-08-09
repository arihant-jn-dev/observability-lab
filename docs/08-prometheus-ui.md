# The Prometheus UI — what you can do there

**http://localhost:9090** · no login · Prometheus **3.1.0**

Prometheus is one of the few components in this lab with its own UI (Loki and
Tempo have none — they're API-only, so Grafana is the only way to see them).

Every query below was run against your stack and returns real data. Sample
values are from an actual run.

**Contents**

0. [What Prometheus is doing for us](#0-what-prometheus-is-doing-for-us)
1. [The pages](#1-the-pages)
2. [The query page](#2-the-query-page)
3. [PromQL, built up in six steps](#3-promql-built-up-in-six-steps)
4. [What to check here — a practical catalogue](#4-what-to-check-here--a-practical-catalogue)
5. [Gotchas that will bite you](#5-gotchas-that-will-bite-you)
6. [Prometheus UI vs Grafana](#6-prometheus-ui-vs-grafana)

---

## 0. What Prometheus is doing for us

### In one sentence

Prometheus **collects numbers from every part of the stack on a timer, stores
them as time series, lets you query them with PromQL, and evaluates alert rules
against them.**

It is the **metrics** database of the three signals — the cheap, complete one.

### What it's actually doing right now, in your stack

| | |
|---|---|
| Scraping | **7 targets**, every **10 seconds** |
| Holding | **6,810 active series** across **1,056 distinct metric names** |
| Retaining | **6 hours** (a lab doesn't need more) |
| Evaluating | **12 alert rules**, every 15–30s |
| Storing | **exemplars** — the `trace_id` that links a graph to a trace |

Nothing pushes to Prometheus. **It goes and asks.** Every 10 seconds it makes an
HTTP GET to each target's `/metrics` endpoint, parses the text it gets back, and
appends the numbers to its database:

```
Prometheus ──GET /metrics──► otel-collector:8889   (all your app metrics)
           ──GET /metrics──► postgres-exporter:9187
           ──GET /metrics──► redis-exporter:9121
           ──GET /metrics──► node-exporter:9100
           ──GET /metrics──► cadvisor:8080
           ──GET /metrics──► otel-collector:8888   (collector's own health)
           ──GET /metrics──► localhost:9090        (itself)
```

**Why pulling matters:** if a target dies, the scrape fails and `up` becomes
`0` — that's a *signal you can alert on*. If Prometheus were push-based, a dead
service would simply go quiet, and silence is indistinguishable from "healthy
but no traffic". This is why `ServiceDown` is one of the five alerts allowed to
page you.

### What a "time series" actually is

Every unique combination of metric name + labels is its own series, storing a
stream of `(timestamp, value)` pairs:

```
http_server_request_duration_seconds_count{http_route="/checkout", http_response_status_code="201"}
  ├─ 14:32:10 → 3581
  ├─ 14:32:20 → 3584
  └─ 14:32:30 → 3586
```

Change `/checkout` to `/products` and that's a **different series**. This is
also why cardinality matters: 6,810 series is fine, but one unbounded label
(a user id, an order id) would turn that into millions — see
[04-cardinality.md](04-cardinality.md).

### What you can do with it

**Answer "how much / how often / how bad", cheaply, over time.**

- **Is the system healthy right now?** — error ratio, p99 latency, request rate
- **Is this worse than an hour ago?** — every query works over a time range
- **Which route / container / database is responsible?** — slice by label
- **Alert me when it breaks** — the 12 rules in
  [alerts.yml](../observability/prometheus/rules/alerts.yml) are just PromQL
  expressions with a threshold and a duration
- **Is my monitoring itself healthy?** — `/targets` and `/tsdb-status`
- **Give me a starting point for an investigation** — find *when* and *which
  route*, then take the `trace_id` from an exemplar into Tempo

### What it deliberately cannot do

Worth knowing up front, so you don't waste time trying:

| Question | Why not | Go to |
|---|---|---|
| "**Which** request was slow?" | Metrics are aggregates — that detail was discarded at collection time, on purpose, to make them cheap | Tempo |
| "**Why** did it fail?" | A counter can say 30% failed; it cannot contain the error message | Loki |
| "What did we do for customer 4471?" | High-cardinality labels would destroy the database | Traces/logs |
| "What happened in that 2-second blip?" | It only sees samples every 10s | Traces |

That trade is the entire point of metrics: **complete coverage, no detail.**
Prometheus is how you find *where to look* — then you spend the expensive
signals only there.

### Where it sits

```
your app ──OTLP──► otel-collector ──exposes :8889──► PROMETHEUS ──► Grafana
                                                          │
                                                          └──► alert rules
```

Prometheus never talks to your application. The collector exposes a `/metrics`
endpoint; Prometheus scrapes it. Your app has no idea Prometheus exists.

---

## 1. The pages

| Page | URL | What it's for |
|---|---|---|
| **Query** | [/query](http://localhost:9090/query) | Write PromQL, see tables and graphs |
| **Alerts** | [/alerts](http://localhost:9090/alerts) | What's firing **right now** |
| **Rules** | [/rules](http://localhost:9090/rules) | All 12 rules + evaluation health |
| **Targets** | [/targets](http://localhost:9090/targets) | Is anything failing to scrape? |
| **Service discovery** | [/service-discovery](http://localhost:9090/service-discovery) | Labels before/after relabelling |
| **TSDB status** | [/tsdb-status](http://localhost:9090/tsdb-status) | **Cardinality health** |
| **Config** | [/config](http://localhost:9090/config) | The running `prometheus.yml` |
| **Flags** | [/flags](http://localhost:9090/flags) | Command-line flags in effect |

> In Prometheus 3.x the old `/graph` URL redirects to `/query`. If a tutorial
> says "go to /graph", that's the same page.

### Targets — check this first when graphs look wrong

[/targets](http://localhost:9090/targets) shows all **7** scrape targets. A flat
graph and a dead scrape look identical, so this page answers "is the data even
arriving?" before you debug anything else.

```
cadvisor                 http://cadvisor:8080/metrics            UP
node-exporter            http://node-exporter:9100/metrics       UP
otel-collector           http://otel-collector:8889/metrics      UP   ← all app metrics
otel-collector-internal  http://otel-collector:8888/metrics      UP
postgres-exporter        http://postgres-exporter:9187/metrics   UP
prometheus               http://localhost:9090/metrics           UP
redis-exporter           http://redis-exporter:9121/metrics      UP
```

If `otel-collector` is DOWN, **every application graph goes flat** and looks
exactly like "no traffic". That distinction matters more than almost anything
else on this page.

### Alerts — three states

[/alerts](http://localhost:9090/alerts) shows each rule as:

- **Inactive** — condition false
- **Pending** — condition true, but the `for:` duration hasn't elapsed
- **Firing** — condition held for the full duration

Watching the Pending→Firing transition is the clearest way to understand why
`for:` exists. Trigger it:

```bash
curl -XPOST localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"errorRate":{"enabled":true,"pct":40}}'
# generate traffic, then watch /alerts — HighErrorRate goes Pending, then
# Firing about 2 minutes later
make heal
```

### TSDB status — your cardinality dashboard

[/tsdb-status](http://localhost:9090/tsdb-status) shows total series and the
biggest label/metric offenders. Your stack currently holds **~6,787 series**.

This is the page that would have caught the `process_command_args` leak
described in [04-cardinality.md](04-cardinality.md) — it was the largest label
in the database at 211 KB.

---

## 2. The query page

[/query](http://localhost:9090/query) has two tabs that answer different questions:

| Tab | Gives you | Use when |
|---|---|---|
| **Table** | one value per series, **right now** | "what is it currently?" |
| **Graph** | values over a time range | "how did it change?" |

Practical notes:

- **Autocomplete** — start typing and it suggests metric names and label values.
  The fastest way to discover what exists.
- **Metrics explorer** — the button beside the query box lists every metric name.
- **Explain tab** — Prometheus 3.x breaks your query into a tree and explains
  each part. Genuinely useful while learning.
- **Add panel** — compare several queries on one page.
- The **`{}` browser** lets you click through label values instead of typing.

---

## 3. PromQL, built up in six steps

### Step 1 — select a metric

```promql
up
```
→ `7 series, value 1` (one per target; `1` = healthy, `0` = down)

Filter with labels in `{}`:

```promql
up{job="otel-collector"}
http_server_request_duration_seconds_count{http_route="/checkout"}
```

Matchers: `=` equals · `!=` not equals · `=~` regex · `!~` regex-not

```promql
container_memory_usage_total_bytes{container_name=~"obslab-.*"}
```
→ `13 series`

### Step 2 — know your metric type

This determines what you're allowed to do with it.

| Type | Meaning | Name usually ends | What to do |
|---|---|---|---|
| **Counter** | only goes up | `_total` | `rate()` / `increase()` — **never** graph raw |
| **Gauge** | up and down | — | use directly |
| **Histogram** | distribution in buckets | `_bucket`/`_sum`/`_count` | `histogram_quantile()` |

Graphing a raw counter gives an ever-climbing line that tells you nothing:

```promql
http_server_request_duration_seconds_count     # 19 series, value 3586 — useless
```

### Step 3 — `rate()` turns counters into "per second"

```promql
rate(http_server_request_duration_seconds_count[5m])
```
→ `19 series, e.g. 0.069` (requests/sec, averaged over 5 minutes)

`[5m]` is the **lookback window**. Rules of thumb for this lab:

- Scrape interval is **10s**, so a window needs **≥ 1m** (4+ scrapes) to be stable
- `[1m]` = responsive, noisy · `[5m]` = smooth, slower to react
- Too short → gaps and `NaN`. Too long → real spikes get flattened away

`rate()` also handles counter resets automatically — when a container restarts
and the counter drops to zero, `rate()` doesn't produce a negative spike.

Use `increase()` when you want a total rather than a per-second value:

```promql
increase(orders_created_total[1h])       # orders in the last hour
```

### Step 4 — aggregate

Raw queries return one series *per label combination*. Collapse them:

```promql
sum(rate(http_server_request_duration_seconds_count[5m]))
```
→ `1 series, 0.276` — total requests/sec

```promql
sum by (http_route) (rate(http_server_request_duration_seconds_count[5m]))
```
→ `12 series` — one per route

- `sum by (x)` — **keep only** label `x`
- `sum without (x)` — keep everything **except** `x`

Other aggregators: `avg`, `min`, `max`, `count`, `topk`, `bottomk`.

```promql
topk(5, count by (__name__)({__name__=~".+"}))     # the 5 biggest metrics
```

### Step 5 — percentiles from histograms

```promql
histogram_quantile(0.99,
  sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))
```
→ `p99 = 0.13s`

Three things that must be right:

1. `rate()` on the `_bucket` series (they're counters)
2. `sum by (le)` — **`le` must survive the aggregation**, it's the bucket boundary
3. Aggregate buckets **first**, then compute the quantile

Add a label to split by route:

```promql
histogram_quantile(0.50,
  sum by (http_route, le) (rate(http_server_request_duration_seconds_bucket[5m])))
```
→ `12 series` — p50 per route

The average, for contrast (see [02-percentiles.md](02-percentiles.md)):

```promql
sum(rate(http_server_request_duration_seconds_sum[5m]))
  /
sum(rate(http_server_request_duration_seconds_count[5m]))
```

### Step 6 — ratios, thresholds and time-shifts

Divide two rates for a ratio. **Alert on ratios, never counts** — 50 errors/sec
is catastrophic at 100 rps and irrelevant at 100k rps:

```promql
sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))
  /
sum(rate(http_server_request_duration_seconds_count[5m]))
```
→ `0.0` when healthy

```promql
sum(rate(cache_operations_total{result="hit"}[5m]))
  / sum(rate(cache_operations_total[5m]))
```
→ `0.95`

Comparison operators **filter** — they return only series matching:

```promql
nodejs_eventloop_delay_p99_seconds > 0.001
container_memory_usage_total_bytes / container_memory_usage_limit_bytes > 0.8
```

`offset` compares against the past:

```promql
sum(rate(http_server_request_duration_seconds_count[5m]))
  - sum(rate(http_server_request_duration_seconds_count[5m] offset 5m))
```
→ change in request rate vs 5 minutes ago

---

## 4. What to check here — a practical catalogue

Copy-paste these. All verified working.

### Is the system alive?

```promql
up                                          # 1 = up, 0 = down
sum(rate(http_server_request_duration_seconds_count[5m]))    # total rps
```

### RED — the service

```promql
# Rate, by route
sum by (http_route) (rate(http_server_request_duration_seconds_count{service_name="orders-api"}[5m]))

# Errors, as a ratio
sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))
  / sum(rate(http_server_request_duration_seconds_count[5m]))

# Duration
histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))
histogram_quantile(0.50, sum by (http_route, le) (rate(http_server_request_duration_seconds_bucket[5m])))

# Which status codes?
sum by (http_response_status_code) (rate(http_server_request_duration_seconds_count[5m]))
```

### USE — the resources

```promql
# memory as a fraction of the container LIMIT (what actually kills you)
container_memory_usage_total_bytes / container_memory_usage_limit_bytes

# CPU per container
container_cpu_utilization_ratio{container_name=~"obslab-.*"}

# Node saturation — high delay + low CPU = blocked on something synchronous
nodejs_eventloop_delay_p99_seconds

# THE most under-appreciated series here: requests queueing for a DB connection
db_pool_connections{state="waiting"}

# V8 heap — compare against container memory during a buffer-mode leak
sum by (service_name, service_role) (v8js_memory_heap_used_bytes)
```

### Business

```promql
sum by (status) (rate(orders_created_total[5m]))
increase(orders_created_total[1h])
histogram_quantile(0.99, sum by (le) (rate(job_queue_lag_seconds_bucket[5m])))
queue_depth
```

### Datastores

```promql
rate(redis_keyspace_hits_total[5m]) / (rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m]))
rate(redis_evicted_keys_total[5m])                          # silent data loss
rate(pg_stat_database_blks_read{datname="ordersdb"}[5m])    # disk reads
sum(pg_stat_activity_count{datname="ordersdb"})
sum(rate(db_client_operation_duration_seconds_count[5m]))   # THIS is what N+1 moves
```

### Cardinality health

```promql
prometheus_tsdb_head_series                                 # ~6,787 currently
topk(10, count by (__name__)({__name__=~".+"}))
count({__name__="http_server_request_duration_seconds_bucket"})   # 285 series
```

### Which pathologies are on

```promql
lab_pathologies_active
max by (pathology) (lab_pathologies_active) > 0
```

---

## 5. Gotchas that will bite you

**`rate()` on a gauge returns nonsense.** `rate()` assumes monotonic increase.
Applying it to `queue_depth` or `db_pool_connections` produces garbage. Counters
only.

**Your range must exceed the scrape interval.** With 10s scrapes, `rate(...[15s])`
has ~1 data point and returns nothing. Use `[1m]` minimum, `[5m]` for stability.

**Never average percentiles.**
```promql
avg(p99_by_instance)      # ✗ mathematically meaningless
histogram_quantile(0.99, sum by (le) (rate(..._bucket[5m])))   # ✓
```
The p99 of a set of p99s is not the p99 of anything.

**`le` must survive aggregation.** `sum by (http_route) (...)` without `le`
breaks `histogram_quantile` — it needs the bucket boundaries.

**Percentiles are capped by your top bucket.** Ours is 10s. If real p99 were
30s, you'd get ~10s reported confidently. Check:
```promql
sum(rate(http_server_request_duration_seconds_bucket{le="+Inf"}[5m]))
  - sum(rate(http_server_request_duration_seconds_bucket{le="10"}[5m]))
```

**Division by zero gives `NaN`.** Guard ratios:
```promql
sum(rate(a[5m])) / clamp_min(sum(rate(b[5m])), 0.001)
```

**Empty result ≠ zero.** A series with no recent samples disappears entirely
(after ~5 min it goes stale). "No data" and "the value is 0" mean very different
things — that's why `orders_failed_total` shows nothing until something actually
fails.

**Prometheus only sees samples.** Anything that happened entirely between two
scrapes is invisible. A 1-second cache-refill storm doesn't exist in 10-second
metrics — see [exercise 4](exercises/04-flush-cache.md).

---

## 6. Prometheus UI vs Grafana

Both query the same data. Use them for different things.

| | Prometheus UI | Grafana |
|---|---|---|
| Writing/debugging one query | ✅ best | ok |
| Autocomplete + Explain | ✅ | ✅ |
| Seeing why an alert fired | ✅ `/alerts`, `/rules` | ✅ |
| Are scrapes healthy? | ✅ `/targets` — **only here** | ✗ |
| Cardinality health | ✅ `/tsdb-status` — **only here** | ✗ |
| Several panels together | ✗ | ✅ |
| **Click a spike → open the trace** | ✗ | ✅ **exemplars** |
| Logs alongside metrics | ✗ | ✅ |
| Saved dashboards | ✗ | ✅ |

**The rule of thumb:** debug a *query* in Prometheus; investigate an *incident*
in Grafana. Prometheus can never take you from a latency spike to the trace that
caused it — that link only exists in Grafana.

And two pages exist **only** here: `/targets` and `/tsdb-status`. When graphs
look wrong, check `/targets` before you doubt your query.

---

Related: [02-percentiles.md](02-percentiles.md) ·
[04-cardinality.md](04-cardinality.md) · [05-alerts.md](05-alerts.md) ·
[07-api-reference.md](07-api-reference.md)
