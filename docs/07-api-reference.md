# API reference

Every endpoint in the lab, in two groups:

- **[Part 1 — External](#part-1--external-apis-browser--curl)**: published to a host
  port. You can open these in a browser or hit them with `curl` from your Mac.
- **[Part 2 — Internal](#part-2--internal-apis-container-network-only)**: only
  reachable inside the Compose network. This is how services talk to each other.

Every `curl` below was executed against the running stack and returns the status
shown. Response bodies are real output, not illustrations.

---

## The one thing that trips people up

**Host ports ≠ container ports.**

From your Mac you use `localhost:<host port>`. Inside the network, services use
**service name + container port**:

```bash
# from your Mac
curl http://localhost:8080/health

# from inside a container (this is what the app actually does)
curl http://orders-api:8080/health
curl http://otel-collector:4318/v1/traces
```

`localhost` inside a container means *that container*, not your Mac. Almost
everyone hits this once.

---

# What each service is for

Before the endpoints, here is what you are actually talking to.

| Service | Port | One line | Plane |
|---|---|---|---|
| **orders-api** | 8080 | The application under study | Data |
| **orders-worker** | — | Background job consumer | Data |
| **payments-api** | 8081 | Stand-in third-party gateway | Data |
| **postgres** | 5433 | System of record | Data |
| **redis** | 6380 | Cache **and** job queue | Data |
| **otel-collector** | 4317/4318/8889 | The telemetry seam — receives, processes, routes | Telemetry |
| **prometheus** | 9090 | Metrics store + alert engine | Telemetry |
| **tempo** | 3210 | Trace store | Telemetry |
| **loki** | 3110 | Log store | Telemetry |
| **alloy** | 12345 | Log shipper agent | Telemetry |
| **cadvisor** | 8083 | Per-container resource metrics | Telemetry |
| **node-exporter** | 9100 | Host/VM metrics | Telemetry |
| **postgres-exporter** | 9187 | Database internals | Telemetry |
| **redis-exporter** | 9121 | Cache internals | Telemetry |
| **grafana** | 3300 | Investigation UI — correlates all three signals | Query |
| **k6** | — | Load generator (on demand) | Tooling |

---

## Data plane — the services doing business work

### orders-api — `:8080`
The Fastify HTTP API you are learning to observe. Handles products, orders and
checkout; reads through Redis to Postgres; writes orders and enqueues async
work. **All seven pathologies live here**, toggled at runtime through
`/admin/pathologies` with no restart — because restarting would reset the very
memory profile and metric history you are trying to study.
→ [endpoints](#11-orders-api--8080)

### orders-worker — no port
The same image as orders-api, run with a different command (`ROLE=worker`). It
polls the Redis queue and completes orders asynchronously.

It exists because **async work is where observability gets hard**. It runs in a
*different process*, so trace context does not reach it for free — the app has
to pass it through the job payload by hand. It is also why "the request
succeeded" and "the work actually happened" are two different questions, which
is what makes queue *lag* worth its own metric.

### payments-api — `:8081`
A stand-in "third-party payment gateway". It exists for exactly one reason: a
trace with one service in it teaches you nothing about distributed tracing. With
two, you can watch a request cross a process boundary and see latency attributed
to the service that actually caused it.

It is also the target of `slowDependency` — orders-api asks it to be slow via
the `x-simulate-delay-ms` header, so the delay genuinely happens *in another
process* rather than being faked locally.
→ [endpoints](#12-payments-api--8081)

### postgres — `:5433`
The system of record: 200 customers, 500 products, 5,000 orders, 20,000 line
items. It is the slow, stateful thing every other component exists to protect —
most interesting failures in this lab are ultimately about load arriving here
that was supposed to be absorbed somewhere else.

### redis — `:6380`
Plays **two very different roles**, and the lab uses both:

- **Cache** for `/products` — a *performance* component whose loss is supposed
  to be survivable (the `flushCache` exercise tests that assumption).
- **Job queue** the worker consumes — a *correctness* component whose loss means
  orders silently stop being fulfilled.

Same container, completely different blast radius.

---

## Telemetry plane — generating, shipping, storing

### otel-collector — `:4317` / `:4318` / `:8889`
**The seam.** The app speaks one protocol (OTLP) to one address and knows
nothing about Prometheus, Tempo or Loki. Swap a backend and no app code changes.

It receives OTLP from all three services, plus per-container stats from the
Docker socket, then: limits memory, **trims resource attributes** (cardinality
control), batches, computes **spanmetrics** from traces — which is what produces
exemplars — and routes everything onward. Cost control (sampling, attribute
dropping) belongs here, not scattered through service code.
→ [scrape endpoints](#17-scrape-endpoints--raw-metrics)

### prometheus — `:9090`
Stores **metrics** and evaluates the 12 alert rules. Metrics are cheap enough to
keep for every request forever — which is exactly why they are aggregates, and
why they can never tell you *which* request was slow.

It **pulls** from every target every 10s. That matters: a dead target produces
`up == 0`, which is a *signal*. A push system that goes quiet produces nothing,
which is indistinguishable from healthy-but-idle.
→ [query API](#14-prometheus--9090)

### tempo — `:3210`
Stores **traces** — individual requests, with every span, duration and parent.
Deliberately dumb compared to Prometheus: it barely indexes, which is what makes
storing every span affordable. Essentially `trace_id → trace`, plus TraceQL for
scanning.

That design dictates the workflow: **metrics first** to find when and which
route, grab a `trace_id` from an exemplar, then ask Tempo for that one trace.
Searching Tempo blind is slow, and is why people conclude "tracing is useless".
→ [query API](#15-tempo--3210)

### loki — `:3110`
Stores **logs**. Its core idea: do *not* index the log text — index only a small
set of labels, store the rest compressed, brute-force scan at query time. That
is why it is cheap, and it dictates the one rule: **labels narrow the stream,
they are not for searching.**

Which is why `trace_id` is stored as *structured metadata*, not a label. As a
label it would create one stream per request and destroy the index.
→ [query API](#16-loki--3110)

### alloy — `:12345`
The **log shipper**. Reads container stdout via the Docker API, parses the Pino
JSON, splits fields into bounded labels vs unbounded structured metadata, and
pushes to Loki.

Why a shipper at all, instead of the app pushing its own logs? Because writing
to stdout is the most robust thing an app can do — stdout survives the app
crashing, OOMing, or losing network, since Docker already captured the line. An
app that ships its own logs loses exactly the logs describing its own death.

### cadvisor — `:8083`
Per-container CPU, memory and network — the "U" and "S" of USE. Your app's own
metrics tell you what it *thinks* it is doing; this tells you what the kernel
actually gave it.

> **macOS caveat:** on Docker Desktop it reports only the root cgroup with no
> container names. Per-container metrics in this lab come from the collector's
> `docker_stats` receiver instead. cAdvisor is kept because it is what you will
> meet on real Linux hosts.

### node-exporter — `:9100`
Host-level metrics: CPU, memory, load, disk, network. Answers "is the box itself
the problem?"

> On macOS this reports the Docker Desktop **VM**, not your Mac. Treat it as
> "the VM my containers share".

### postgres-exporter — `:9187`
Database internals. Your app can only see Postgres from outside — it knows a
query took 40 ms but not why. This exposes what Postgres knows about itself:
active connections vs `max_connections`, buffer cache hit ratio, rows fetched vs
returned, locks, and per-query stats via `pg_stat_statements`.

### redis-exporter — `:9121`
Cache internals. The app records its own hit/miss counter, but that only covers
code paths you remembered to instrument. Redis knows the truth about keyspace
hits/misses, memory, connected clients — and **evictions**, which are silent
data loss that looks identical to a cache that was never warm.

---

## Query plane

### grafana — `:3300`
The **investigation UI**, and the only component that talks to all three stores —
therefore the only place the three signals become one workflow.

It does not generate or store anything. What it adds is **correlation**: click a
latency spike → land in that exact trace → jump to the log lines for that one
request. That wiring lives in `datasources.yaml` and is the most important
config file in the repo.
→ [API](#13-grafana--3300)

---

## Tooling

### k6 — no port, runs on demand
Load generator. A pathology with no traffic is invisible: metrics are rates, so
with zero requests every graph is flat and every percentile is `NaN`.

Nine scenarios, each running a healthy baseline first, then switching on one
pathology, then healing. Started with
`docker compose run --rm k6 run /scripts/01-baseline.js`.

---

# Part 1 — External APIs (browser / curl)

## 1.1 orders-api — `:8080`

The service under study. 14 endpoints.

### Summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. Never touches dependencies |
| GET | `/ready` | Readiness. Checks Postgres + Redis |
| GET | `/products` | List products (Redis read-through cache) |
| GET | `/products/:id` | One product (cached) |
| GET | `/orders` | List orders — **the N+1 endpoint** |
| GET | `/orders/:id` | One order + line items |
| POST | `/orders` | Create order, enqueue job for worker |
| POST | `/checkout` | Create order, **call payments-api** |
| GET | `/admin/pathologies` | Current failure state + memory |
| POST | `/admin/pathologies` | Turn failures on/off (merge-patch) |
| POST | `/admin/pathologies/reset` | Everything off + free leaked memory |
| GET | `/admin/cache/stats` | Redis key count + hit/miss |
| POST | `/admin/cache/flush` | Empty Redis **now** |
| POST | `/admin/memory/release` | Free leaked memory + run GC |

---

### Health

```bash
curl -s http://localhost:8080/health
# {"status":"ok","pid":30}
```

```bash
curl -s http://localhost:8080/ready
# {"ready":true,"checks":{"postgres":"ok","redis":"ok"}}
```

**Why two.** `/health` answers "is this process alive?" and never touches
dependencies. `/ready` answers "can it serve traffic?" and checks Postgres and
Redis. If a liveness probe checked the database, one DB blip would make the
orchestrator kill every healthy instance at once.

Redis being down returns `degraded`, not failure — it's a cache, not a source of
truth. Both are excluded from tracing so health checks don't dominate your span
volume or flatter your p50.

---

### Products — the cached read path

```bash
# query params: category (default all), limit (default 50, max 200)
curl -s 'http://localhost:8080/products?limit=1'
```
```json
{"count":1,"cacheHit":false,"products":[{"id":1,"sku":"SKU-00001",
"name":"Product 1","category":"books","price_cents":537,"stock":11,
"units_sold":"90","order_count":"20"}]}
```

```bash
curl -s 'http://localhost:8080/products?category=books&limit=5'
curl -s http://localhost:8080/products/1
# {"cacheHit":false,"product":{"id":1,"sku":"SKU-00001",...}}
```

**Watch `cacheHit` flip.** Same request twice — first `false`, then `true`:

```bash
curl -s -XPOST http://localhost:8080/admin/cache/flush > /dev/null
curl -s 'http://localhost:8080/products?limit=3' | grep -o '"cacheHit":[a-z]*'   # false
curl -s 'http://localhost:8080/products?limit=3' | grep -o '"cacheHit":[a-z]*'   # true
```

`units_sold` and `order_count` come from an aggregate over all 20,000
`order_items` — **~17.5 ms**, deliberately expensive. That's what makes the cache
load-bearing. Cache hit ≈ 2.4 ms, miss ≈ 12.6 ms.

Categories: `all`, `electronics`, `books`, `clothing`, `home`, `toys`.

---

### Orders — the N+1 endpoint

```bash
curl -s 'http://localhost:8080/orders?limit=1'
```
```json
{"count":1,"queryCount":2,"orders":[{"id":8565,"customer_id":167,
"status":"paid","total_cents":15043,"created_at":"...","items":[]}]}
```

**`queryCount` is the teaching field.** Both code paths return identical data:

```bash
curl -s 'http://localhost:8080/orders?limit=50' | python3 -c 'import sys,json;print("queryCount:",json.load(sys.stdin)["queryCount"])'
# queryCount: 2

curl -s -XPOST http://localhost:8080/admin/pathologies \
  -H 'content-type: application/json' -d '{"nPlusOne":{"enabled":true}}'

curl -s 'http://localhost:8080/orders?limit=50' | python3 -c 'import sys,json;print("queryCount:",json.load(sys.stdin)["queryCount"])'
# queryCount: 51

curl -s -XPOST http://localhost:8080/admin/pathologies/reset
```

```bash
curl -s http://localhost:8080/orders/1
```

`limit` defaults to 25, max 100.

---

### Create an order — write + enqueue

```bash
# everything optional; omitted fields are randomised
curl -s -XPOST http://localhost:8080/orders \
  -H 'content-type: application/json' \
  -d '{"customerId":7,"items":[{"productId":10,"quantity":2}]}'
# {"orderId":5001,"totalCents":1740,"status":"pending"}
```

Returns **201** with status `pending`. It then enqueues a job to Redis; the
worker picks it up and flips the row to `shipped`:

```bash
OID=$(curl -s -XPOST http://localhost:8080/orders -H 'content-type: application/json' -d '{}' \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["orderId"])')
sleep 3
docker compose exec -T postgres psql -U lab -d ordersdb -tAc "SELECT status FROM orders WHERE id=$OID"
# shipped
```

---

### Checkout — the cross-service call

```bash
curl -s -XPOST http://localhost:8080/checkout \
  -H 'content-type: application/json' \
  -d '{"customerId":5,"amountCents":4200}'
# {"orderId":8566,"status":"paid","amountCents":4200}
```

**201** when approved, **402** when declined. Amounts **≥ 500000** cents are
declined by payments-api by design — a legitimate, non-injected source of 402s:

```bash
curl -s -XPOST http://localhost:8080/checkout \
  -H 'content-type: application/json' -d '{"amountCents":900000}'
# {"orderId":8567,"status":"failed","amountCents":900000}
```

This is the endpoint that produces a trace spanning **both services**.

---

### Admin — the control panel

> Unauthenticated and dangerous by design. Bound to localhost, lab only.
> **`/admin/*` and `/health` are exempt from every pathology** — otherwise
> `errorRate: 100` would break the endpoint you need to switch it back off.

```bash
curl -s http://localhost:8080/admin/pathologies | python3 -m json.tool
```

Returns all seven pathologies plus a memory snapshot: `rssMb`, `heapUsedMb`,
`heapTotalMb`, `externalMb`, `retainedMb`, `chunks`.

**Setting them** — shallow merge, so send only what changes:

```bash
# latency on ONE route
curl -s -XPOST http://localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"slow":{"enabled":true,"ms":800,"route":"/products"}}'

# fail a percentage of requests
curl -s -XPOST http://localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"errorRate":{"enabled":true,"pct":25}}'

# block the event loop
curl -s -XPOST http://localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"cpuBurn":{"enabled":true,"ms":250}}'

# leak OFF-heap (V8 heap metrics stay FLAT) vs ON-heap
curl -s -XPOST http://localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"memLeak":{"enabled":true,"kbPerRequest":4096,"mode":"buffer"}}'
curl -s -XPOST http://localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"memLeak":{"enabled":true,"kbPerRequest":4096,"mode":"heap"}}'

# 1 query becomes 51
curl -s -XPOST http://localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"nPlusOne":{"enabled":true}}'

# make payments-api slow (delay happens in THAT process)
curl -s -XPOST http://localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"slowDependency":{"enabled":true,"ms":5000}}'

# unbounded metric label — damages Prometheus on purpose
curl -s -XPOST http://localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"cardinalityBomb":{"enabled":true}}'
```

**Full payload shape:**

| Pathology | Fields |
|---|---|
| `slow` | `enabled`, `ms`, `route` |
| `errorRate` | `enabled`, `pct` |
| `cpuBurn` | `enabled`, `ms` |
| `memLeak` | `enabled`, `kbPerRequest`, `mode` (`buffer`\|`heap`) |
| `nPlusOne` | `enabled` |
| `slowDependency` | `enabled`, `ms` |
| `cardinalityBomb` | `enabled` |

**Reset and one-shot actions:**

```bash
# all off + release leaked memory
curl -s -XPOST http://localhost:8080/admin/pathologies/reset

# cache state
curl -s http://localhost:8080/admin/cache/stats
# {"keys":2,"keyspaceHits":23270,"keyspaceMisses":7989}

# empty Redis right now (an ACTION, not a toggle — you can't "be flushing")
curl -s -XPOST http://localhost:8080/admin/cache/flush
# {"flushed":true,"keysEvicted":174}

# free leaked memory + run GC (needs --expose-gc, already set)
curl -s -XPOST http://localhost:8080/admin/memory/release
```

---

## 1.2 payments-api — `:8081`

The downstream dependency. Exists so traces cross a process boundary.

```bash
curl -s http://localhost:8081/health
# {"status":"ok"}
```

```bash
curl -s -XPOST http://localhost:8081/authorize \
  -H 'content-type: application/json' \
  -d '{"orderId":1,"amountCents":4200,"customerId":5}'
# {"approved":true,"authId":"auth_jhwq73pn","reason":null}
```

**200** approved, **402** declined (`amountCents >= 500000`):

```bash
curl -s -XPOST http://localhost:8081/authorize \
  -H 'content-type: application/json' -d '{"orderId":1,"amountCents":900000}'
# {"approved":false,"authId":null,"reason":"amount_exceeds_limit"}
```

**The `x-simulate-delay-ms` header** is how `slowDependency` works. orders-api
sets it; payments-api sleeps for that long. The delay genuinely happens *in this
process*, which is why the trace assigns blame correctly:

```bash
time curl -s -XPOST http://localhost:8081/authorize \
  -H 'content-type: application/json' \
  -H 'x-simulate-delay-ms: 3000' \
  -d '{"orderId":1,"amountCents":4200}'
# ~3.0s
```

---

## 1.3 Grafana — `:3300`

Anonymous auth is on, so **no credentials needed** — in the browser or via API.

| What | URL |
|---|---|
| Home | http://localhost:3300 |
| RED dashboard | http://localhost:3300/d/red-service |
| USE dashboard | http://localhost:3300/d/use-resources |
| Explore | http://localhost:3300/explore |
| Alerting | http://localhost:3300/alerting/list |

```bash
curl -s http://localhost:3300/api/health

# the three datasources
curl -s http://localhost:3300/api/datasources | python3 -c "
import sys,json
for d in json.load(sys.stdin): print(d['name'], d['type'], d['url'])"

# list dashboards
curl -s 'http://localhost:3300/api/search?type=dash-db'

# fetch a dashboard's JSON
curl -s http://localhost:3300/api/dashboards/uid/red-service

# inspect the correlation wiring
curl -s http://localhost:3300/api/datasources/uid/prometheus \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['jsonData']['exemplarTraceIdDestinations'])"
```

---

## 1.4 Prometheus — `:9090`

UI: http://localhost:9090 · Targets: `/targets` · Alerts: `/alerts`

```bash
# instant query
curl -s http://localhost:9090/api/v1/query --data-urlencode 'query=up'

# request rate by route
curl -s http://localhost:9090/api/v1/query \
  --data-urlencode 'query=sum by (http_route) (rate(http_server_request_duration_seconds_count{service_name="orders-api"}[1m]))'

# p99 latency
curl -s http://localhost:9090/api/v1/query \
  --data-urlencode 'query=histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))'

# range query (for graphs)
curl -s http://localhost:9090/api/v1/query_range \
  --data-urlencode 'query=up' \
  --data-urlencode "start=$(($(date +%s)-300))" \
  --data-urlencode "end=$(date +%s)" --data-urlencode 'step=60'
```

**Exemplars — the metric→trace link:**

```bash
curl -s http://localhost:9090/api/v1/query_exemplars \
  --data-urlencode 'query=traces_span_metrics_duration_milliseconds_bucket' \
  --data-urlencode "start=$(($(date +%s)-600))" --data-urlencode "end=$(date +%s)"
```

**Operational:**

```bash
curl -s http://localhost:9090/api/v1/targets       # is anything down?
curl -s http://localhost:9090/api/v1/rules         # the 12 alert rules
curl -s http://localhost:9090/api/v1/alerts        # what's firing NOW
curl -s http://localhost:9090/api/v1/status/tsdb   # cardinality health
curl -s http://localhost:9090/api/v1/label/__name__/values   # every metric name
curl -s -XPOST http://localhost:9090/-/reload      # reload rules, no restart
curl -s http://localhost:9090/-/healthy
```

**Cardinality check** (see [04-cardinality.md](04-cardinality.md)):

```bash
curl -s http://localhost:9090/api/v1/status/tsdb \
  | python3 -c "import sys,json;print('series:',json.load(sys.stdin)['data']['headStats']['numSeries'])"
```

---

## 1.5 Tempo — `:3210`

Query API only — you normally view traces **through Grafana**.

```bash
# TraceQL search — ask for what you want
curl -s -G http://localhost:3210/api/search \
  --data-urlencode 'q={name="POST /checkout"}' \
  --data-urlencode "start=$(($(date +%s)-600))" \
  --data-urlencode "end=$(date +%s)" --data-urlencode 'limit=5'

# by duration — find the slow ones
curl -s -G http://localhost:3210/api/search \
  --data-urlencode 'q={duration > 1s}' \
  --data-urlencode "start=$(($(date +%s)-600))" --data-urlencode "end=$(date +%s)"

# by service
curl -s -G http://localhost:3210/api/search \
  --data-urlencode 'q={resource.service.name="payments-api"}' \
  --data-urlencode "start=$(($(date +%s)-600))" --data-urlencode "end=$(date +%s)"

# fetch one trace by id
curl -s http://localhost:3210/api/traces/<TRACE_ID>

curl -s http://localhost:3210/api/search/tags
curl -s http://localhost:3210/ready
```

**Print a waterfall** — grab the slowest checkout and show where time went:

```bash
TID=$(curl -s -G http://localhost:3210/api/search \
  --data-urlencode 'q={name="POST /checkout"}' \
  --data-urlencode "start=$(($(date +%s)-600))" \
  --data-urlencode "end=$(date +%s)" --data-urlencode 'limit=1' \
  | python3 -c "import sys,json;t=json.load(sys.stdin).get('traces',[]);print(t[0]['traceID'] if t else '')")

curl -s "http://localhost:3210/api/traces/$TID" | python3 -c "
import sys,json
rows=[]
for b in json.load(sys.stdin).get('batches',[]):
    svc=next((a['value']['stringValue'] for a in b['resource']['attributes'] if a['key']=='service.name'),'?')
    for ss in b.get('scopeSpans',[]):
        for s in ss.get('spans',[]):
            rows.append((int(s['startTimeUnixNano']),svc,s['name'],
                        (int(s['endTimeUnixNano'])-int(s['startTimeUnixNano']))/1e6))
rows.sort()
for _,svc,n,d in rows: print('  %-14s %-38s %8.2fms' % (svc,n[:38],d))
"
```

> `/ready` can briefly return **503** ("waiting for 15s after being ready") right
> after Tempo cuts a block. The query APIs still work. Not an error.

---

## 1.6 Loki — `:3110`

```bash
# all logs from a service
curl -s -G http://localhost:3110/loki/api/v1/query_range \
  --data-urlencode 'query={service="orders-api"}' \
  --data-urlencode "start=$(($(date +%s)-300))000000000" \
  --data-urlencode "end=$(date +%s)000000000" --data-urlencode 'limit=20'

# errors only
curl -s -G http://localhost:3110/loki/api/v1/query_range \
  --data-urlencode 'query={service="orders-api", level="error"}' \
  --data-urlencode "start=$(($(date +%s)-600))000000000" \
  --data-urlencode "end=$(date +%s)000000000"

# just the worker
curl -s -G http://localhost:3110/loki/api/v1/query_range \
  --data-urlencode 'query={service="orders-api", role="worker"}' \
  --data-urlencode "start=$(($(date +%s)-600))000000000" \
  --data-urlencode "end=$(date +%s)000000000"

curl -s http://localhost:3110/loki/api/v1/labels
curl -s http://localhost:3110/loki/api/v1/label/service/values
```

**The correlation query — logs for one request:**

```bash
curl -s -G http://localhost:3110/loki/api/v1/query_range \
  --data-urlencode "query={service=\"orders-api\"} | trace_id = \"$TID\"" \
  --data-urlencode "start=$(($(date +%s)-600))000000000" \
  --data-urlencode "end=$(date +%s)000000000"
```

`trace_id` works as a filter but is **not** an indexed label — it's structured
metadata. As a label it would create one Loki stream per request.

Indexed labels: `service`, `role`, `level`, `container`, `compose_service`, `job`.

> `/ready` may also return a transient **503**. Query APIs still work.

---

## 1.7 Scrape endpoints — raw metrics

Plain text. Useful for checking *what actually exists* before writing a query.

| Endpoint | Contains | Lines |
|---|---|---|
| http://localhost:8889/metrics | **app + spanmetrics + docker_stats** | ~2277 |
| http://localhost:8083/metrics | cAdvisor | ~1004 |
| http://localhost:9100/metrics | node_exporter | ~818 |
| http://localhost:9187/metrics | postgres_exporter | ~668 |
| http://localhost:9121/metrics | redis_exporter | ~563 |
| http://localhost:12345/metrics | Alloy | ~219 |

```bash
# every metric name the app emits
curl -s http://localhost:8889/metrics | grep -oE '^[a-zA-Z_][a-zA-Z0-9_]*' | sort -u

# see exemplars in the raw (the '#' after the value)
curl -s -H 'Accept: application/openmetrics-text' http://localhost:8889/metrics | grep -m2 trace_id

# specific families
curl -s http://localhost:9187/metrics | grep '^pg_stat_database_blks_read'
curl -s http://localhost:9121/metrics | grep '^redis_evicted_keys_total'
curl -s http://localhost:8889/metrics | grep '^container_memory_usage_total_bytes'
```

Alloy UI (pipeline debugging): http://localhost:12345 ·
cAdvisor UI: http://localhost:8083

---

# Part 2 — Internal APIs (container network only)

Not published to your Mac. This is the plumbing.

```
orders-api ─┐
orders-worker├── OTLP/HTTP :4318 ──► otel-collector ──► tempo:4317 (OTLP gRPC)
payments-api┘                              ▲
                                           │ Prometheus PULLS :8889 / :8888
containers ── stdout ──► alloy ── push ──► loki:3100
```

## 2.1 App → Collector (OTLP push)

The only telemetry address the app knows.

| From | To | Protocol |
|---|---|---|
| orders-api, orders-worker, payments-api | `http://otel-collector:4318` | OTLP/HTTP |

Paths: `/v1/traces`, `/v1/metrics`, `/v1/logs`.
Set by `OTEL_EXPORTER_OTLP_ENDPOINT` in `docker-compose.yml`.

```bash
docker compose exec -T orders-api sh -c \
  'curl -s -o /dev/null -w "%{http_code}\n" -XPOST http://otel-collector:4318/v1/traces \
   -H "content-type: application/json" -d "{}"'
# 200
```

`4317` (gRPC) and `4318` (HTTP) **are** published to the host, so you can push
telemetry from your Mac too — useful for testing the pipeline without the app.

## 2.2 Collector → Tempo (OTLP gRPC push)

| From | To | Protocol |
|---|---|---|
| otel-collector | `tempo:4317` | OTLP/gRPC |

Tempo's `4317`/`4318` are **deliberately not published** — publishing them would
collide with the collector's own ports. Configured in
`observability/otel-collector/config.yaml` as `exporters.otlp/tempo`.

## 2.3 Prometheus → everything (pull)

Prometheus **pulls** every 10s. Exactly what it scrapes:

```bash
curl -s 'http://localhost:9090/api/v1/targets?state=active' | python3 -c "
import sys,json
for t in sorted(json.load(sys.stdin)['data']['activeTargets'], key=lambda x:x['labels']['job']):
    print('  %-26s %-42s %s' % (t['labels']['job'], t['scrapeUrl'], t['health']))"
```
```
  cadvisor                   http://cadvisor:8080/metrics               up
  node-exporter              http://node-exporter:9100/metrics          up
  otel-collector             http://otel-collector:8889/metrics         up
  otel-collector-internal    http://otel-collector:8888/metrics         up
  postgres-exporter          http://postgres-exporter:9187/metrics      up
  prometheus                 http://localhost:9090/metrics              up
  redis-exporter             http://redis-exporter:9121/metrics         up
```

Note **`otel-collector:8888`** (the collector's *own* health metrics) is
**internal-only** — it is not in the compose `ports:` list. Reach it via:

```bash
docker compose exec -T orders-api sh -c \
  'curl -s http://otel-collector:8888/metrics | head -5'
```

That pull model is why a dead target produces `up == 0` — a *signal*. A push
system going quiet is indistinguishable from healthy-but-idle.

## 2.4 Alloy → Loki (push)

| From | To |
|---|---|
| alloy | `http://loki:3100/loki/api/v1/push` |

Alloy reads container stdout via `/var/run/docker.sock`, parses the Pino JSON,
then pushes. Configured in `observability/alloy/config.alloy`.

## 2.5 Docker socket consumers

Two containers mount `/var/run/docker.sock:ro`:

| Container | Why |
|---|---|
| **alloy** | discover containers + read their log streams |
| **otel-collector** | `docker_stats` receiver — per-container CPU/mem/net |

## 2.6 Grafana → the three stores

| From | To |
|---|---|
| grafana | `http://prometheus:9090` |
| grafana | `http://tempo:3200` |
| grafana | `http://loki:3100` |

Note Grafana uses Tempo's **internal** port `3200`, not the host's `3210`.
Configured in `datasources.yaml`.

## 2.7 App → datastores

| From | To | Protocol |
|---|---|---|
| orders-api, orders-worker | `postgres:5432` | Postgres wire |
| orders-api, orders-worker | `redis:6379` | RESP |
| orders-api | `http://payments-api:8081/authorize` | HTTP |

```bash
docker compose exec -T orders-api sh -c \
  'curl -s -o /dev/null -w "%{http_code}\n" http://payments-api:8081/health'
# 200

docker compose exec -T postgres psql -U lab -d ordersdb -c 'SELECT count(*) FROM products;'
docker compose exec -T redis redis-cli DBSIZE
docker compose exec -T redis redis-cli LLEN orders:queue
```

Note **container port 5432 / 6379**, while the host sees **5433 / 6380**.

---

## Quick reference

```bash
# app
curl -s http://localhost:8080/health
curl -s 'http://localhost:8080/products?limit=5'
curl -s 'http://localhost:8080/orders?limit=25'
curl -s -XPOST http://localhost:8080/orders   -H 'content-type: application/json' -d '{}'
curl -s -XPOST http://localhost:8080/checkout -H 'content-type: application/json' -d '{}'

# control
curl -s http://localhost:8080/admin/pathologies
curl -s -XPOST http://localhost:8080/admin/pathologies/reset      # = make heal

# observability
curl -s http://localhost:9090/api/v1/query --data-urlencode 'query=up'
curl -s http://localhost:9090/api/v1/alerts
curl -s http://localhost:3110/loki/api/v1/labels
curl -s http://localhost:3300/api/health
curl -s http://localhost:8889/metrics | head
```

Related: [00-how-this-was-built.md](00-how-this-was-built.md) ·
[01-first-look.md](01-first-look.md) · [exercises](exercises/)
