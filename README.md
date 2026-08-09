# Observability Lab

A deliberately breakable order/checkout API wired to a full self-hosted
observability stack — built to teach you how to diagnose production systems.

The code is the vehicle. The goal is that you can look at a graph and know what
to do next.

**15 containers · ~1.05 GB RAM · everything local.**

---

## Start here

```bash
docker compose up -d --build     # ~2 min first time
docker compose ps                # all healthy
make verify-all                  # 56 end-to-end assertions
open http://localhost:3300       # Grafana, no login
```

Then, in order:

```bash
# 1. learn your normal — you cannot recognise abnormal without it
docker compose run --rm k6 run /scripts/01-baseline.js

# 2. break something and watch
docker compose run --rm k6 run /scripts/03-errors.js
```

…and follow [docs/exercises/](docs/exercises/).

---

## The reading

| Doc | Question it answers |
|---|---|
| **[How this was built](docs/00-how-this-was-built.md)** | Step by step: every decision, file, and integration point |
| **[What to look at first](docs/01-first-look.md)** | Something's wrong. Now what, in what order? |
| **[Why percentiles beat averages](docs/02-percentiles.md)** | With real numbers measured on this stack |
| **[Metrics vs traces vs logs](docs/03-signals.md)** | What each answers — and what each is *bad* at |
| **[The cardinality trap](docs/04-cardinality.md)** | How to take down your monitoring with your own instrumentation |
| **[Which alerts are worth waking for](docs/05-alerts.md)** | Page on symptoms, ticket on causes |
| **[API reference](docs/07-api-reference.md)** | Every endpoint, external and internal, with curl |
| **[The Prometheus UI](docs/08-prometheus-ui.md)** | Writing PromQL, and what to check where |
| **[Fastify](docs/09-fastify.md)** | The web framework: routes, hooks, and the request lifecycle |
| **[Database connections](docs/10-database-connections.md)** | Pooling, limits, and why Postgres and MySQL differ |
| **[Guided exercises](docs/exercises/)** | Seven pathologies, run → look → why |

---

## Port map

Chosen to avoid what was already running on your machine: `3000`, `3001`,
`4000`, `5432` (pgvector), `6379` (host Redis), `3306`/`33060`.

| Port | Service | What it's for |
|---|---|---|
| **3300** | **Grafana** | Your main window. No login. |
| 8080 | orders-api | The service under study |
| 8081 | payments-api | Downstream dependency — makes traces cross a process |
| 5433 | Postgres | System of record |
| 6380 | Redis | Cache **and** job queue |
| 9090 | Prometheus | Metrics + alerts |
| 3210 | Tempo | Traces |
| 3110 | Loki | Logs |
| 4317/4318 | OTel Collector | OTLP ingest (gRPC/HTTP) |
| 8889 | Collector metrics | What Prometheus scrapes |
| 8083 | cAdvisor | Per-container metrics (see caveat below) |
| 9100 | node_exporter | Host metrics |
| 9187 | postgres_exporter | DB internals |
| 9121 | redis_exporter | Cache internals |
| 12345 | Alloy | Log shipper UI |

All in [.env](.env) — change them in one place.

---

## What's wired to what

```
orders-api ─┐
payments-api├─ OTLP ─→ OTel Collector ─┬─→ Prometheus  (metrics + exemplars)
orders-worker┘                         └─→ Tempo       (traces)
                                            │
     stdout ─→ Alloy ─→ Loki (logs, trace_id as structured metadata)
                                            │
                        Grafana ────────────┘  correlates all three
```

**The correlation loop** (the whole point — wired in
[datasources.yaml](observability/grafana/provisioning/datasources/datasources.yaml)):

```
Prometheus graph ──exemplar──→ Tempo trace ──trace_id──→ Loki logs
       ▲                                                     │
       └──────────────── derived field ──────────────────────┘
```

Verified: one `trace_id` returns 3 log lines — including `job processed` from
the **worker**, a different process entirely.

---

## The pathologies

Toggled at runtime, no restarts. `/admin/*` and `/health` are exempt from all of
them — otherwise `errorRate: 100` would break the endpoint you need to turn it
off.

```bash
make slow          # 800ms on /products only
make error         # 25% of requests 500
make cpu           # 250ms CPU burn per request
make leak-buffer   # 4MB/request OFF-heap  ← heap metrics stay FLAT
make leak-heap     # 4MB/request ON-heap
make nplusone      # 1 query becomes 51
make slowdep       # payments-api takes 5s
make flush         # empty Redis right now
make heal          # all off + release memory
```

Or directly (shallow-merges, so send only what changes):

```bash
curl -XPOST localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"slow":{"enabled":true,"ms":2000,"route":"/products"}}'
curl -s localhost:8080/admin/pathologies | jq
```

### Measured effects

| Pathology | Verified result |
|---|---|
| `slow` | `/products` 706 ms, `/orders` 7 ms — **route-scoped on purpose** |
| `errorRate` | 10/20 requests 500; `HighErrorRate` alert fired at 30.17% |
| `cpuBurn` | 6 ms → 303 ms; event-loop delay spikes |
| `memLeak` buffer | container 162→344 MB, **V8 heap flat** |
| `memLeak` heap | container 122→274 MB, heap 27→161 MB |
| `nPlusOne` | `queryCount` **2 → 51** on `/orders?limit=50` |
| `slowDependency` | `/checkout` 2039 ms, of which **2002 ms inside payments-api** |
| `flushCache` | hit ratio collapses, DB 0.3→79 queries/s, miss 12.6 ms vs hit 2.4 ms |

---

## Design decisions worth knowing

**The `slow` pathology is route-scoped.** "The service is slow" is never true of
every endpoint, and the real skill is finding *which* one. A global slowdown
would let you skip the only step that matters.

**`memLeak` has two modes** because Node `Buffer`s live outside the V8 heap. A
dashboard built on `heapUsed` shows a perfectly healthy process while it leaks
100 MB toward an OOM kill. This is the sharpest "which metrics mislead you"
lesson here — [exercise 6](docs/exercises/06-memleak.md).

**The Postgres pool is capped at 10.** Past that, requests *queue* — nothing
fails, the DB is idle, CPU is flat, everything is slow. The most commonly
misdiagnosed shape of "slow".

**`/products` runs a deliberately expensive query** (17.5 ms aggregate over
20k rows). A cache in front of a 0.5 ms lookup is a strawman — real caches sit
in front of real work.

**The worker is a separate process**, so trace context does *not* reach it for
free. [queue.ts](services/orders-api/src/queue.ts) carries it across by hand.
Over HTTP you get this free; over a queue you never do.

**`/health` vs `/ready` are separate.** A liveness probe that checks the database
turns one DB blip into every instance being killed at once.

---

## Things this build got wrong first (and what they teach)

These are real problems hit while building this, kept because each is a lesson:

**1. `ioredis` must be pinned to v5.** The OTel instrumentation declares
`>=2.0.0 <6`. On ioredis 6 you get **zero Redis spans**, silently — no error,
no warning.

**2. Fastify instrumentation isn't in `getNodeAutoInstrumentations()`.** Without
adding `@fastify/otel` explicitly, HTTP spans are named `GET` with no
`http.route` — every URL either collapses into one useless series or explodes
into thousands.

**3. We created our own cardinality leak.** `resource_to_telemetry_conversion`
promoted *every* resource attribute to a Prometheus label. `process_command_args`
(the whole Node argv) became the largest label in the TSDB at **211 KB**, and
`process_pid`/`host_name` changed on every restart — orphaning series each time.
Fixed with an explicit `resource/trim` allowlist: **19 labels → 9**. Nobody wrote
that label; a default detector added it. See
[docs/04-cardinality.md](docs/04-cardinality.md).

**4. Tempo OOM-killed, and it silently broke *metrics*.** Under a heavy k6 run,
53k traces in 4 min exceeded Tempo's memory limit. Then cache and DB panels read
**zero** while the app was serving 200+ req/s — because the traces exporter
retried forever against a dead Tempo, and the collector's **shared**
`memory_limiter` started refusing everything. Fixed with a bounded
`sending_queue` and capped retry. *Shared infrastructure couples failures you
assumed were independent* — which is exactly why `CollectorDroppingData` exists.

---

**5. Exemplar diamonds never rendered.** The latency panels requested exemplars
from the app's own histograms — but **OTel JS does not emit exemplars at all**
(the classes exist in `sdk-metrics` and are wired to nothing). Exemplars here
come solely from the collector's spanmetrics connector. The duration panels now
query `traces_span_metrics_duration_milliseconds_bucket` with
`span_kind="SPAN_KIND_SERVER"`. `"exemplar": true` is a request, not a guarantee —
if the series has none, Grafana silently draws nothing.

---

## Known caveats on macOS

**cAdvisor reports only the root cgroup** (`id="/"`) on Docker Desktop. Its
Docker factory registers and cgroups are visible, but it cannot walk the
LinuxKit VM's cgroup hierarchy for per-container data — even with the socket
mounted and `cgroup: host`. It is kept because it is what you'll meet on real
Linux hosts and its metric names are worth recognising.

**Per-container metrics come from the collector's `docker_stats` receiver
instead**, which asks the Docker API directly and works identically on macOS and
Linux. That's what the USE dashboard uses.

**node_exporter reports the Docker Desktop VM**, not your Mac. Treat it as "the
VM my containers share".

**Benign log noise:** `docker_stats` logs `context canceled` when it scrapes a
short-lived `--rm` container (like k6). Harmless.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Config edit ignored | Bind-mounted configs aren't re-read on `up -d`. `docker compose restart <service>` |
| Schema/seed edit ignored | `db/init/*.sql` runs only on an empty volume. `docker compose down -v` |
| No traces at all | Something loaded before `import './otel'`. It must be line 1 |
| Dashboards flat | Check http://localhost:9090/targets — a dead collector looks exactly like no traffic |
| Alerts not firing | Most have `for: 2m`. Watch PENDING → FIRING at :9090/alerts |
| Series count exploding | You ran the cardinality bomb. `docker compose restart prometheus` |

---

## Layout

```
docker-compose.yml         heavily annotated — read it
.env                       every port, one place
Makefile                   make help
db/init/                   schema + seed (500 products, 5k orders, 20k items)
services/orders-api/       the service under study
services/payments-api/     downstream dependency
observability/
  otel-collector/          the telemetry seam
  prometheus/              scrape config + alert rules
  tempo/ loki/ alloy/      trace + log backends and shipper
  grafana/                 datasources (the correlation wiring) + dashboards
load/k6/                   9 scenarios, one per pathology
docs/                      the course
scripts/verify-stage1.sh   19 app-layer assertions   (make verify)
scripts/verify-stack.sh    37 pipeline assertions    (make verify-stack)
```
