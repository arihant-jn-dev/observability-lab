# How this project was built, step by step

One document, in build order: every decision, every file, every integration
point, and exactly what is being monitored.

Read this if you want to understand *why the pieces are shaped the way they
are* — or if you want to rebuild something like it yourself.

**Contents**

1. [The mental model](#1-the-mental-model)
2. [Decisions made before writing code](#2-decisions-made-before-writing-code)
3. [Architecture: how data flows](#3-architecture-how-data-flows)
4. [Stage 1 — the application](#stage-1--the-application)
5. [Stage 2 — metrics: app → Collector → Prometheus](#stage-2--metrics-app--collector--prometheus)
6. [Stage 3 — traces: → Tempo, and the exemplar link](#stage-3--traces--tempo-and-the-exemplar-link)
7. [Stage 4 — logs: → Loki, and closing the correlation loop](#stage-4--logs--loki-and-closing-the-correlation-loop)
8. [Stage 5 — infrastructure exporters](#stage-5--infrastructure-exporters)
9. [Stage 6 — dashboards](#stage-6--dashboards)
10. [Stage 7 — alerts](#stage-7--alerts)
11. [Stage 8 — load generation](#stage-8--load-generation)
12. [What we are monitoring — full inventory](#12-what-we-are-monitoring--full-inventory)
13. [The correlation mechanism, in detail](#13-the-correlation-mechanism-in-detail)
14. [Traps hit during the build](#14-traps-hit-during-the-build)
15. [Complete file map](#15-complete-file-map)

---

## 1. The mental model

Three ideas drive every decision in this repo.

**A healthy app teaches nothing.** You cannot learn to read a dashboard from a
system that is always green. So the application has seven switchable
pathologies, flipped at runtime with no restart — because restarting resets the
memory profile and metric history you are trying to study.

**Three signals, three different jobs.** Metrics are cheap and complete but
aggregate (they lose *which request*). Traces are detailed but sampled. Logs are
exact but expensive. A working setup uses the cheap complete signal to find
*where* to look, then spends the expensive ones only there.

**Correlation is the product.** Three databases side by side are three search
boxes. What makes them an observability *system* is being able to click from a
graph into a trace, and from that trace into the log lines for that one request.
That wiring is the most important thing in this repo.

---

## 2. Decisions made before writing code

### The port map

Your machine already had things running. Before writing anything I scanned for
listening ports and found two conflicts beyond the ones you named: **6379 was
taken** (a host Redis) and **3001** was occupied.

Everything lives in [`.env`](../.env) so it changes in one place:

| Port | Service | Why this port |
|---|---|---|
| 3300 | Grafana | 3000 **and** 3001 taken |
| 8080 | orders-api | free |
| 8081 | payments-api | free |
| 5433 | Postgres | 5432 = your pgvector |
| 6380 | Redis | 6379 = your host Redis |
| 9090 | Prometheus | free |
| 3210 | Tempo | 3200 is its default; shifted to avoid the 3000s |
| 3110 | Loki | 3100 is its default; same reason |
| 4317/4318 | OTel Collector | OTLP standard ports, free |
| 8889 | Collector scrape endpoint | what Prometheus pulls from |
| 8083 | cAdvisor | 8080 taken by our own API |
| 9100 / 9187 / 9121 | node / postgres / redis exporters | their conventional ports |
| 12345 | Alloy UI | its default |

### Runtime choices, and the compatibility check that mattered

Before writing a line of app code I checked what the OpenTelemetry
instrumentation actually supports — which caught a trap that would otherwise
have surfaced two stages later as "my Redis spans are missing":

```
@opentelemetry/instrumentation-ioredis  supports  >=2.0.0 <6
npm's current ioredis                             6.0.0
```

On ioredis 6 you get **zero Redis spans, silently**. So ioredis is pinned to
`^5.11.1`. Similar checks confirmed `pg` 8.x and `fastify` 5.x were fine.

**Method worth copying:** before adopting a version, verify the instrumentation
declares support for it. Instrumentation failures are silent by design — a
telemetry library must never crash the app it observes, so it just… does nothing.

### Why TypeScript runs uncompiled

The app runs `.ts` directly via `tsx`, and Compose bind-mounts `./src` over the
image. You can edit code on your Mac and restart a container without rebuilding.
For a lab you will constantly be poking at, that matters more than a production
build pipeline.

---

## 3. Architecture: how data flows

```
┌──────────────┐   ┌──────────────┐   ┌───────────────┐
│  orders-api  │   │ orders-worker│   │ payments-api  │
└──────┬───────┘   └──────┬───────┘   └───────┬───────┘
       │  OTLP/HTTP :4318 │                   │
       └──────────────────┴───────────────────┘
                          ▼
              ┌───────────────────────┐
              │    OTel Collector     │  ← the seam
              │  receivers            │
              │   • otlp              │
              │   • docker_stats      │
              │  processors           │
              │   • memory_limiter    │
              │   • resource/trim     │  ← cardinality control
              │   • batch             │
              │  connectors           │
              │   • spanmetrics       │  ← RED-from-traces + EXEMPLARS
              └───────┬───────────┬───┘
           exposes :8889          │ pushes OTLP
                    │             ▼
            ┌───────▼──────┐  ┌────────┐
            │  Prometheus  │  │ Tempo  │
            └──────────────┘  └────────┘

  stdout (Pino JSON) → Docker → Alloy → Loki

            Grafana reads all three and links them together
```

Two things about this shape are deliberate:

**The app knows one telemetry address.** It speaks OTLP to
`http://otel-collector:4318` and knows nothing about Prometheus, Tempo or Loki.
Swap a backend and no app code changes. Sampling and cardinality control live in
the collector, not scattered through service code.

**Prometheus pulls; everything else pushes.** A pull model means a dead target
produces `up == 0` — a *signal*. A push system that goes quiet produces nothing,
which is indistinguishable from "healthy but idle".

---

## Stage 1 — the application

**Goal:** a working app with no telemetry at all, so you see what an opaque
service looks like before instrumenting it. `OTEL_ENABLED=false` throughout.

### The domain

An order/checkout API over Postgres + Redis, seeded via
[`db/init/01-schema.sql`](../db/init/01-schema.sql) and
[`02-seed.sql`](../db/init/02-seed.sql):

```
200 customers · 500 products · 5,000 orders · 20,000 order_items
```

Sizes were chosen so pathologies are *measurable*: 20k line items make the
expensive aggregate genuinely expensive; 50-row order pages make N+1 hurt.

`order_items.order_id` is **indexed on purpose**. N+1 is not a slow-query
problem — every one of its 50 queries is sub-millisecond. That is exactly why
it is invisible to slow-query logs and obvious in a trace.

### Files, and what each is for

| File | Role | The idea in it |
|---|---|---|
| [`config.ts`](../services/orders-api/src/config.ts) | env → typed config | One image runs as both API and worker; `ROLE` decides |
| [`db.ts`](../services/orders-api/src/db.ts) | Postgres pool | **Pool capped at 10 deliberately** — this is the queueing lesson |
| [`cache.ts`](../services/orders-api/src/cache.ts) | Redis + `readThrough` | Cache failures degrade to the DB, never error |
| [`logger.ts`](../services/orders-api/src/logger.ts) | Pino + trace mixin | 4 lines that create all log↔trace correlation |
| [`pathologies.ts`](../services/orders-api/src/pathologies.ts) | the 7 failure modes | Mutable in-process state, flipped at runtime |
| [`queue.ts`](../services/orders-api/src/queue.ts) | Redis list queue | Manual trace-context propagation across the queue |
| [`metrics.ts`](../services/orders-api/src/metrics.ts) | hand-written metrics | What auto-instrumentation can never know |
| [`server.ts`](../services/orders-api/src/server.ts) | Fastify + pathology hook | Ordering of injected failures |
| [`index.ts`](../services/orders-api/src/index.ts) | API entrypoint | `import './otel'` on line 1 |
| [`worker.ts`](../services/orders-api/src/worker.ts) | queue consumer | Re-attaches to the producer's trace |
| `routes/*.ts` | endpoints | `products`, `orders`, `checkout`, `admin`, `health` |

### The pathology hook

In [`server.ts`](../services/orders-api/src/server.ts), an `onRequest` hook
applies failures in a deliberate order:

1. `errorRate` — fail fast, before doing work
2. `cpuBurn` — block the event loop synchronously
3. `memLeak` — allocate and retain
4. `slow` — await, yielding the loop

**`/admin` and `/health` are exempt.** Without that exemption,
`errorRate: 100` would break the endpoint you need to switch it back off, and
your only recovery would be a restart — which wipes the memory profile you were
studying.

### Two design choices worth calling out

**`slow` is route-scoped**, not global. "The service is slow" is never true of
every endpoint, and the real skill is finding *which* one. A global slowdown
would let you skip the only step that matters.

**`memLeak` has two modes.** `buffer` allocates off-heap; `heap` allocates JS
objects. This was not in the original plan — it emerged from testing, when RSS
climbed 120 MB while `heapUsed` never moved. Node `Buffer`s live outside the V8
heap, so a `heapUsed` dashboard reports a healthy process all the way to the
OOM kill. That became the sharpest "which metrics mislead you" lesson in the lab.

### Verified before moving on

[`scripts/verify-stage1.sh`](../scripts/verify-stage1.sh) — 19 assertions:
seed counts, cache miss→hit, write→queue→worker→DB, cross-service checkout, and
every pathology's measured effect.

---

## Stage 2 — metrics: app → Collector → Prometheus

**Goal:** turn telemetry on and get numbers into Prometheus.

### The critical ordering rule

[`otel.ts`](../services/orders-api/src/otel.ts) must be imported **first**, on
line 1 of both entrypoints:

```ts
import './otel';   // ⚠️ MUST BE FIRST
```

Auto-instrumentation works by monkey-patching libraries as they are `require()`d.
If `pg` loads before the SDK starts, there is nothing left to patch — you get
zero database spans, **with no error message**. "My traces are empty" is almost
always this.

### What the SDK is configured to do

- **Resource attributes** — `service.name`, `service.version`, `service.role`,
  `deployment.environment`. `service.name` is the single most important field in
  the stack: it is what Tempo groups by and what every dashboard filters on.
- **Disabled**: `net`, `dns` (span noise), and `pino` (we do our own trace
  injection explicitly, so you can see where correlation comes from).
- **Ignored**: `/health` and `/metrics` — health checks would otherwise dominate
  trace volume *and* flatter your p50.
- **`enhancedDatabaseReporting: true`** on pg — puts the actual SQL on the span,
  which is what makes N+1 visually obvious.
- **`@fastify/otel` added explicitly** — see [traps](#14-traps-hit-during-the-build).
- Metrics export every **10 s** (aggressive; makes the lab feel responsive).

### Hand-written metrics

[`metrics.ts`](../services/orders-api/src/metrics.ts) adds what
auto-instrumentation *cannot* know, because it doesn't know what your business
does:

```ts
orders.created        counter    labels: status
orders.failed         counter    labels: reason
cache.operations      counter    labels: cache, result(hit|miss)
order.value           histogram  buckets 5…2500 USD
job.duration          histogram  seconds
job.queue_lag         histogram  ← the honest async metric
queue.depth           gauge      observable (polls Redis LLEN)
db.pool.connections   gauge      observable, by state: in_use/idle/WAITING
lab.pathologies.active gauge     which failure modes are on
cardinality.bomb      counter    deliberately dangerous, for teaching
```

Two things to notice:

**Explicit bucket boundaries.** A histogram can only answer questions its
buckets are shaped for. If your top bucket is 1 s and real p99 is 4 s, every
percentile above that boundary is fabricated by interpolation.

**Observable gauges for things that *are*, counters for things that *happen*.**
You cannot `rate()` a value that goes down. Pool size and queue depth are
gauges; orders created is a counter.

### The Collector

[`observability/otel-collector/config.yaml`](../observability/otel-collector/config.yaml)

```yaml
receivers:  otlp (4317 grpc / 4318 http)
processors: memory_limiter → resource/trim → batch
exporters:  prometheus (exposes :8889)
```

**Processor order matters.** `memory_limiter` runs first so it can reject data
*before* anything allocates for it — otherwise the collector OOMs while
processing the batch that would have OOMed it.

**`resource_to_telemetry_conversion: true`** promotes resource attributes to
Prometheus labels. Required to tell `orders-api` from `payments-api` — and the
source of a cardinality problem covered [below](#14-traps-hit-during-the-build).

### Prometheus

[`observability/prometheus/prometheus.yml`](../observability/prometheus/prometheus.yml)
scrapes the collector at `:8889` every 10 s, plus the collector's own health at
`:8888`, plus (from stage 5) the four infra exporters.

Started with `--enable-feature=exemplar-storage`. Without that flag Prometheus
**silently discards** exemplars and the metric→trace link never works.

### Verified

RED queries returning live data: ~10.4 req/s per route, p99 `/checkout` 74 ms,
`http_route` labels correctly populated as route templates.

---

## Stage 3 — traces: → Tempo, and the exemplar link

**Goal:** store individual requests, and make them reachable *from a graph*.

### Tempo

[`observability/tempo/tempo.yaml`](../observability/tempo/tempo.yaml)

Tempo is deliberately dumb compared to Prometheus: it barely indexes. It is
essentially `trace_id → trace`, plus a TraceQL engine that brute-force scans.

That design *is* the economic argument for tracing: storing every span in full
detail is affordable only if you don't index them all. So the cheap question is
"show me trace X" and the expensive one is "find all traces where…".

**Which dictates the workflow:** metrics first to find *when* and *which route*,
grab a `trace_id` from an exemplar, then ask Tempo for that one trace. Searching
Tempo blind is slow and is why people conclude "tracing is useless".

### The spanmetrics connector — the key integration

A *connector* is an exporter and receiver joined: it consumes the traces
pipeline and produces a metrics pipeline.

```yaml
connectors:
  spanmetrics:
    histogram: { explicit: { buckets: [2ms … 10s] } }
    dimensions: [http.route, http.request.method, http.response.status_code]
    exemplars: { enabled: true }        # ← this is the whole point
```

Why bother, when the app already emits `http_server_request_duration`? Because
these carry **exemplars** — each histogram bucket keeps a sample `trace_id`.
That is the mechanism behind "click the latency spike, land in the exact trace".
Without it you can see p99 got worse but have no path from graph to request.

The pipelines fan traces out to two places:

```yaml
traces:  otlp → [otlp/tempo, spanmetrics]
metrics: [otlp, spanmetrics] → prometheus
```

### Verified

A real trace from this stack, showing the full cross-boundary journey:

```
orders-api    POST /checkout              2039.7ms
orders-api      pg.query:INSERT              4.9ms
orders-api      POST                      2006.9ms
payments-api      POST /authorize         2002.9ms   ← different service
orders-api      pg.query:UPDATE              3.5ms
orders-api      lpush                        0.6ms
orders-api    process order job             48.1ms   ← +224ms, different PROCESS
```

Note `process order job` starts long after the HTTP response was sent. That is
the worker, joined to the same trace because
[`queue.ts`](../services/orders-api/src/queue.ts) carried the context by hand.

---

## Stage 4 — logs: → Loki, and closing the correlation loop

**Goal:** logs that carry `trace_id`, and a Grafana that links all three signals.

### Why logs take a different path

Metrics and traces go app → OTLP → collector. Logs go
**app → stdout → Docker → Alloy → Loki**, deliberately.

Writing JSON to stdout is the most robust thing an app can do. stdout survives
the app crashing, OOMing, or losing network — Docker already captured the line.
An app that ships its own logs loses exactly the logs describing its own death,
which are the ones you need.

### Where trace correlation actually comes from

There is no magic. [`logger.ts`](../services/orders-api/src/logger.ts):

```ts
mixin() {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = span.spanContext();
  return sc.traceId ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
}
```

On every log call, look up the currently active span and copy its ids into the
line. That is why a log emitted inside a request is correlated — and why one
emitted from a stray `setTimeout` is not.

### Alloy, and the cardinality decision

[`observability/alloy/config.alloy`](../observability/alloy/config.alloy)
discovers containers over the Docker API, parses the Pino JSON, and splits
fields two ways:

```alloy
stage.labels               { level, service, role }      # BOUNDED → indexed
stage.structured_metadata  { trace_id }                  # UNBOUNDED → not indexed
```

**This split is the whole game.** In Loki, labels *are* the index, and each
unique combination is a separate stream. `trace_id` as a label would create one
stream per request and destroy the database. As structured metadata it is fully
queryable (`| trace_id = "abc…"`) and costs nothing in the index.

Same principle as Prometheus labels, different database: high-cardinality
identifiers attach to **individual events**, never to the index dimension.

### Grafana: the correlation wiring

[`datasources.yaml`](../observability/grafana/provisioning/datasources/datasources.yaml)
is the most important config file in the repo. Three links:

```yaml
Prometheus.exemplarTraceIdDestinations  → tempo    # graph → trace
Tempo.tracesToLogsV2                    → loki     # trace → logs
Loki.derivedFields (matcherType: label) → tempo    # log → trace
```

### Verified

One `trace_id` returned **3 log lines**, including `job processed` from the
worker — a different process entirely.

---

## Stage 5 — infrastructure exporters

**Goal:** the "U" and "S" of USE — what the kernel and the datastores know,
independent of what the app thinks.

| Exporter | Answers | Metric count |
|---|---|---|
| postgres_exporter | connections, cache hit ratio, rows, locks, per-query stats | 387 |
| redis_exporter | keyspace hits/misses, **evictions**, memory, clients | 208 |
| node_exporter | host CPU, memory, disk, network | 139 |
| cAdvisor | per-container resource use | 96 |
| `docker_stats` (in collector) | per-container CPU/mem/net | 13 |

`pg_stat_statements` is preloaded via a Postgres `command` flag — it cannot be
enabled with `CREATE EXTENSION` alone.

### The macOS caveat, honestly

**cAdvisor does not work fully on Docker Desktop.** It reports only the root
cgroup (`id="/"`) with no container names. I tried the documented fixes: mounting
the Docker socket directly (its factory *does* then register), and `cgroup: host`
for the cgroup v2 namespace. Neither made it enumerate containers — it cannot
walk the LinuxKit VM's cgroup hierarchy.

Rather than ship a broken panel, per-container metrics come from the collector's
**`docker_stats` receiver**, which queries the Docker API and works identically
on macOS and Linux. cAdvisor is kept because it is what you will meet on real
Linux hosts and its metric names are worth recognising.

**node_exporter reports the Docker Desktop VM, not your Mac.** Being clear about
what a metric actually measures is half the skill.

---

## Stage 6 — dashboards

Provisioned from JSON via
[`dashboards.yaml`](../observability/grafana/provisioning/dashboards/dashboards.yaml).

### RED — the service (15 panels)

[`red-service.json`](../observability/grafana/dashboards/red-service.json).
Read top to bottom:

- **Rate** — req/s by route; throughput by status class
- **Errors** — error *ratio* (not count) service-wide, then by route
- **Duration** — p50/p95/p99 **with exemplars enabled**, p99 by route, and a
  **heatmap**
- **Business** — orders/sec, cache hit ratio, queue depth & lag
- **Active pathologies** — so you never debug a symptom you injected earlier

The latency panel deliberately also plots the mean, labelled **"MEAN (the
liar)"**, so you can watch it fail to react during the exercises.

The heatmap earns its place: percentiles are a lossy 3-number summary, and only
the heatmap shows **bimodality** — two bands meaning two populations, which no
percentile can represent.

### USE — the resources (18 panels)

[`use-resources.json`](../observability/grafana/dashboards/use-resources.json):
container CPU/memory (with the **limit line** drawn), event-loop delay, V8 heap
(placed next to container memory so the leak lesson is a glance apart), Postgres
pool state / rows / block reads / connections, Redis hits / **evictions** /
latency, and both sides of the outbound dependency call.

Every query was verified to return data before shipping — a dashboard full of
"No data" teaches nothing. Two bugs were caught this way:
`container_cpu_utilization` was actually `container_cpu_utilization_ratio`, and
`orders_failed_total` needed a real decline to exist.

---

## Stage 7 — alerts

[`observability/prometheus/rules/alerts.yml`](../observability/prometheus/rules/alerts.yml)
— 12 rules in three groups.

> **Page on symptoms. Ticket on causes.**

There are ~5 symptoms and unlimited causes. Alert on causes and you write alerts
forever and still get taken down by the one you didn't predict. Symptom alerts
catch novel failures: you didn't predict the mechanism, but you predicted users
would notice.

**Page (symptoms):** `HighErrorRate`, `HighLatencyP99`, `OrdersStopped`,
`QueueLagGrowing`, `ServiceDown`

**Ticket (causes):** `DbPoolSaturated`, `CacheHitRatioCollapsed`,
`RedisEvictingKeys`, `ContainerNearMemoryLimit`, `EventLoopBlocked`

**Meta:** `PrometheusCardinalityGrowing`, `CollectorDroppingData`

Three rules are worth studying:

**`OrdersStopped`** is the most important. Every other alert can be green while
the business is dead — a deploy returning empty carts gives 0% errors, great
latency, zero revenue. Note the guard: it only fires when checkout *traffic
exists* but orders don't. That is the difference between "quiet" and "broken".

**`ContainerNearMemoryLimit`** measures the **container limit**, not heap. An
alert on `heapUsed` would have been silent through the entire off-heap leak.
Alert at the boundary that actually kills you.

**Every symptom alert is a ratio, with a `for` clause.** Counts don't survive
traffic growth; `for` is what stops a 30-second blip from paging someone.

**Verified:** drove 40% errors and watched `HighErrorRate` go PENDING → **FIRING**
at 30.17%.

---

## Stage 8 — load generation

Nine k6 scenarios in [`load/k6/`](../load/k6/), run on demand via a Compose
profile so they don't start with the stack.

Every scenario has the same shape, using two concurrent k6 scenarios — a `load`
executor generating traffic and a `controller` that toggles pathologies on a
timeline:

```
60s healthy baseline → 180s with ONE pathology → heal
```

**The baseline is not padding.** Without a "before" on the graph you cannot tell
an elevated p99 from a normally-high one.

```bash
docker compose run --rm k6 run /scripts/01-baseline.js
```

---

## 12. What we are monitoring — full inventory

### From the application (OTel SDK)

**Auto-instrumented — you wrote no code for these:**

| Metric | What it measures |
|---|---|
| `http_server_request_duration_seconds{_bucket,_count,_sum}` | Inbound HTTP — the RED source. Labels: `http_route`, `http_request_method`, `http_response_status_code` |
| `http_client_request_duration_seconds*` | Outbound HTTP — your side of a dependency call |
| `db_client_operation_duration_seconds*` | Postgres query duration + **count** (count is what N+1 moves) |
| `db_client_connection_count`, `db_client_connection_pending_requests` | Driver-level pool view |
| `nodejs_eventloop_delay_{min,mean,max,p50,p90,p99,stddev}_seconds` | **Node saturation** — more diagnostic than CPU% |
| `nodejs_eventloop_utilization_ratio`, `nodejs_eventloop_time_seconds_total` | Loop busyness |
| `v8js_memory_heap_used_bytes`, `v8js_memory_heap_space_*` | V8 heap — **misses off-heap leaks** |
| `v8js_gc_duration_seconds*` | GC pause time |

**Hand-written — auto-instrumentation cannot know these:**

| Metric | Why it exists |
|---|---|
| `orders_created_total{status}` | The business outcome. Powers `OrdersStopped` |
| `orders_failed_total{reason}` | Failures that aren't HTTP errors |
| `order_value_USD{_bucket,_count,_sum}` | Revenue distribution |
| `cache_operations_total{cache,result}` | Hit/miss ratio from the app's view |
| `queue_depth{queue}` | Jobs waiting |
| `job_queue_lag_seconds*` | **How long a job waited** — the honest async metric |
| `job_duration_seconds*` | Worker processing time |
| `db_pool_connections{state}` | `in_use` / `idle` / **`waiting`** |
| `lab_pathologies_active{pathology}` | Which failures are switched on |
| `cardinality_bomb_total{order_id,customer_id}` | Deliberately dangerous, for teaching |

**Derived from traces (spanmetrics connector):**

| Metric | Note |
|---|---|
| `traces_span_metrics_calls_total` | RED computed from spans |
| `traces_span_metrics_duration_milliseconds*` | **Carries exemplars** — the metric→trace link |

### From infrastructure

| Source | Key series |
|---|---|
| `docker_stats` | `container_cpu_utilization_ratio`, `container_memory_usage_total_bytes`, `container_memory_usage_limit_bytes`, `container_network_io_usage_*` |
| postgres_exporter | `pg_stat_database_{blks_read,blks_hit,tup_returned,tup_fetched,xact_commit}`, `pg_stat_activity_count`, `pg_settings_max_connections`, `pg_locks_count` |
| redis_exporter | `redis_keyspace_{hits,misses}_total`, `redis_evicted_keys_total`, `redis_memory_{used,max}_bytes`, `redis_connected_clients`, `redis_commands_processed_total` |
| node_exporter | `node_cpu_seconds_total`, `node_memory_*`, `node_load*`, `node_disk_*`, `node_network_*` |
| Prometheus itself | `up`, `prometheus_tsdb_head_series` |
| Collector itself | `otelcol_exporter_send_failed_*` |

### Traces

100% sampled (a lab, not production). Spans cover inbound HTTP with route
templates, Fastify handler/hook phases, every Postgres query **with SQL text**,
every Redis command, outbound HTTP with automatic context propagation, and the
worker's job span reattached to the producing request's trace.

### Logs

Structured Pino JSON from `orders-api`, `orders-worker`, `payments-api`, plus
raw stdout from Postgres/Redis/Grafana. Indexed labels: `service`, `role`,
`level`, `container`, `compose_service`. `trace_id` as structured metadata.

---

## 13. The correlation mechanism, in detail

The thing that makes this a system rather than three databases.

```
   Prometheus                 Tempo                    Loki
   ──────────                 ─────                    ────
   p99 spike
      │
      │ exemplar carries trace_id
      │ (spanmetrics → OpenMetrics → exemplar-storage)
      ▼
   ┌──────────────────────► trace 4976f232…
                               │
                               │ tracesToLogsV2:
                               │   filter by service.name → Loki label
                               │   filter by trace_id → structured metadata
                               ▼
                            ┌────────────────────────► 3 log lines
                                                          │
                            ◄─────────────────────────────┘
                              derivedFields: trace_id label → Tempo
```

Four things must all be true, and each is easy to get wrong:

1. **Exemplars generated** — `spanmetrics.exemplars.enabled: true`
2. **Exemplars survive the scrape** — `enable_open_metrics: true` on the
   collector's Prometheus exporter
3. **Exemplars stored** — `--enable-feature=exemplar-storage` on Prometheus
4. **`trace_id` on the log line** — the Pino mixin, plus Alloy putting it in
   structured metadata rather than a label

Miss any one and the loop breaks silently.

---

## 14. Traps hit during the build

Four real problems, kept in the documentation because each is a lesson.

### 1. ioredis 6 gets zero Redis spans

The instrumentation declares `>=2.0.0 <6`; npm's latest is 6.0.0. No error, no
warning — just no spans. Caught before writing code by inspecting the
instrumentation's declared range. Pinned to `^5.11.1`.

### 2. Fastify instrumentation is not in the auto set

`getNodeAutoInstrumentations()` returns 39 instrumentations and Fastify is not
among them. Without adding it, HTTP spans are named `GET` with **no
`http.route`** — so every distinct URL either collapses into one meaningless
series or explodes into thousands. That one line is the difference between a
usable RED dashboard and a useless one.

(`@opentelemetry/instrumentation-fastify` is deprecated; `@fastify/otel` is the
maintained replacement.)

### 3. We created our own cardinality leak

`resource_to_telemetry_conversion` promoted **every** resource attribute to a
Prometheus label. Measured:

```
process_command_args   211,456 bytes   ← the entire Node argv, as a label value
process_executable_path 51,920 bytes
process_pid / host_name                ← change on EVERY container restart
```

`process_command_args` was the single largest label in the database. And because
pid and hostname changed on restart, every `docker compose up` orphaned the old
series and created a fresh set — a slow leak.

**Nobody wrote that label.** A default resource detector added it and one config
flag promoted it. That is the normal way cardinality problems arrive: not from a
bad decision, but from a default.

Fixed with an explicit `resource/trim` allowlist in the collector:
**19 labels per series → 9.**

### 4. Tempo OOM-killed — and it silently broke *metrics*

Under a heavy k6 run, 53,000 traces in 4 minutes exceeded Tempo's memory limit
(exit 137). Expected-ish.

What was *not* expected: cache and DB panels read **zero** while the app was
demonstrably serving 200+ req/s. The traces exporter retried forever against a
dead Tempo, its unbounded queue grew, and `memory_limiter` — **shared by every
pipeline in the collector** — began refusing data across the board.

**One dead backend silently degraded a completely different signal.**

Fixed three ways: a bounded `sending_queue` (500) with a capped 60 s retry so
traces drop instead of starving metrics; Tempo tuned to cut blocks faster
(`max_block_duration: 2m`, `max_block_bytes: 50MB`), which dropped its footprint
from 582 MB to negligible; and `restart: unless-stopped` everywhere.

This is also why `CollectorDroppingData` exists as an alert. When a dashboard
goes blank, *"is the telemetry pipeline healthy?"* is a real question.

### 5. The exemplar diamonds didn't appear — OTel JS cannot emit exemplars

The RED dashboard's latency panels were built against the app's own
`http_server_request_duration_seconds_bucket` with `"exemplar": true` set. No
diamonds ever rendered.

Cause: **the OpenTelemetry JS SDK does not emit exemplars.** The classes exist
in `@opentelemetry/sdk-metrics` (`WithTraceExemplarFilter`,
`AlignedHistogramBucketExemplarReservoir`) but nothing references them — there
is no `exemplarFilter` wiring in the MeterProvider, no attachment during
collection, and no env var. They are dormant code.

Measured on the collector's scrape endpoint:

```
http_server_request_duration_seconds_bucket        0 lines with exemplars
traces_span_metrics_duration_milliseconds_bucket  52 lines with exemplars
```

So exemplars in this stack come from **one place only**: the collector's
spanmetrics connector, which builds them from spans it is already processing.

Fix: the two duration panels now query
`traces_span_metrics_duration_milliseconds_bucket` filtered to
`span_kind="SPAN_KIND_SERVER"` (without that filter, Fastify's internal handler
spans pollute the percentiles), with the unit changed from seconds to
milliseconds.

**The general lesson:** `"exemplar": true` on a panel is a *request*, not a
guarantee. If the underlying series carries no exemplars, Grafana silently
renders nothing. Verify with `/api/v1/query_exemplars` before trusting a
click-through workflow.

### A sixth thing: an exercise that didn't reproduce

The original brief for `flushCache` was "watch DB QPS spike and p99 blow out".
Testing showed **it doesn't at this scale** — including with `PG_POOL_MAX=3` and
30 concurrent readers, pool `waiting` stayed at 0.

The arithmetic: 10 connections ÷ 17.5 ms = ~570 q/s before anything queues; the
flush produces ~79/s. And with only ~500 cache keys the refill storm lasts about
**one second** — shorter than the 10 s scrape interval, so the most violent
moment is *invisible to metrics*.

Rather than rig the demo, the exercise documents what actually happens, the
arithmetic for why real systems *do* fall over, and a config to make it hurt.
The scrape-interval blindness turned out to be the better lesson.

---

## 15. Complete file map

```
observability-lab/
├── docker-compose.yml          629 lines, heavily annotated — read it
├── .env                        every host port, one place
├── Makefile                    make help
│
├── db/init/
│   ├── 01-schema.sql           4 tables + indexes + pg_stat_statements
│   └── 02-seed.sql             200 customers, 500 products, 5k orders, 20k items
│
├── services/orders-api/        the service under study
│   ├── Dockerfile              tsx, no build step, src bind-mounted
│   └── src/
│       ├── otel.ts             (152) SDK bootstrap — MUST import first
│       ├── metrics.ts          (155) hand-written business metrics
│       ├── pathologies.ts      (159) the 7 failure modes
│       ├── server.ts            (97) Fastify + pathology hook
│       ├── worker.ts           (134) queue consumer, rejoins the trace
│       ├── queue.ts             (56) manual trace propagation
│       ├── logger.ts            (49) Pino + trace mixin
│       ├── cache.ts             (73) Redis read-through
│       ├── db.ts                (47) pool capped at 10 on purpose
│       ├── config.ts            (28)
│       ├── index.ts             (34) API entrypoint
│       └── routes/             products, orders, checkout, admin, health
│
├── services/payments-api/       downstream dependency (makes traces cross)
│
├── observability/
│   ├── otel-collector/config.yaml   (248) the seam — receivers/processors/connectors
│   ├── prometheus/prometheus.yml     scrape config
│   ├── prometheus/rules/alerts.yml   12 rules, page vs ticket
│   ├── tempo/tempo.yaml              trace store, memory-tuned
│   ├── loki/loki.yaml                log store, structured metadata on
│   ├── alloy/config.alloy      (116) log shipper + the label/metadata split
│   └── grafana/
│       ├── provisioning/datasources/datasources.yaml   ★ the correlation wiring
│       ├── provisioning/dashboards/dashboards.yaml
│       └── dashboards/red-service.json · use-resources.json
│
├── load/k6/                    lib.js + 9 scenarios
├── scripts/
│   ├── verify-stage1.sh        19 app-layer assertions   (make verify)
│   └── verify-stack.sh         37 pipeline assertions    (make verify-stack)
└── docs/
    ├── 00-how-this-was-built.md   ← you are here
    ├── 01-first-look.md           triage runbook
    ├── 02-percentiles.md          with real data from this stack
    ├── 03-signals.md              what each signal is bad at
    ├── 04-cardinality.md          the trap, incl. the one we hit
    ├── 05-alerts.md               page vs ticket
    └── exercises/                 7 guided exercises
```

### Verify it all still works

```bash
make verify-all     # 56 assertions: 19 app-layer + 37 pipeline
```

---

**Next:** [What to look at first](01-first-look.md) ·
[Guided exercises](exercises/)
