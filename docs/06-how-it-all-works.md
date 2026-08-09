# How it all works

A walkthrough of the stack, following the path data actually takes: from a
request arriving, to telemetry being generated, to a human investigating it.

**Contents**

1. [The big picture](#1-the-big-picture)
2. [How it's all defined: Docker Compose](#2-how-its-all-defined-docker-compose)
3. [The data plane: where the work happens](#3-the-data-plane-where-the-work-happens)
4. [What is OpenTelemetry?](#4-what-is-opentelemetry)
5. [OTLP and the Collector](#5-otlp-and-the-collector)
6. [Where the signals are stored](#6-where-the-signals-are-stored)
7. [Grafana: the query plane](#7-grafana-the-query-plane)
8. [Running and operating it](#8-running-and-operating-it)
9. [The complete picture](#9-the-complete-picture)

---

## 1. The big picture

You have three major planes:

```
                 YOUR APPLICATION
                       │
                       ▼
              ┌─────────────────┐
              │   DATA PLANE    │
              │                 │
              │ orders-api      │
              │ payments-api    │
              │ postgres        │
              │ redis           │
              │ orders-worker   │
              └────────┬────────┘
                       │
                       │ telemetry
                       ▼
              ┌─────────────────┐
              │ TELEMETRY PLANE │
              │                 │
              │ OTel Collector  │
              │ Prometheus      │
              │ Tempo           │
              │ Alloy           │
              │ Loki            │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  QUERY PLANE    │
              │                 │
              │    Grafana      │
              └─────────────────┘
```

Think of it like:

- **Data plane** → application actually does business work.
- **Telemetry plane** → watches what the application is doing.
- **Query plane** → gives you a UI to investigate what happened.

This separation is very common in real systems.

---

## 2. How it's all defined: Docker Compose

```bash
docker compose up -d --build
```

Docker Compose lets you define all these services together:

```
orders-api
payments-api
postgres
redis
orders-worker
otel-collector
prometheus
tempo
loki
alloy
grafana
...
```

And it wires up what depends on what:

```
orders-api
    │
    ├── postgres
    ├── redis
    ├── payments-api
    └── otel-collector
```

---

## 3. The data plane: where the work happens

### Your request enters

```
Browser / k6
       │
       ▼
orders-api :8080
```

### Why payments-api exists

You could have written payment logic directly inside orders-api.

```
orders-api
     │
     │ HTTP
     ▼
payments-api
```

Because this represents a separate service/process.

Real systems commonly look like:

```
Order Service
     │
     ├── Payment Service
     ├── Inventory Service
     ├── User Service
     └── Shipping Service
```

---

## 4. What is OpenTelemetry?

OpenTelemetry, usually called **OTel**, is a standard way of generating and
transporting observability data.

Three major signals:

- Traces
- Metrics
- Logs

**Metrics:**

```
CPU = 60%
Memory = 2GB
HTTP requests = 1,000/sec
Error rate = 2%
Latency = 300ms
```

**Logs:**

```
payment failed
order created
database connection error
```

**Traces:** what exactly happened during this request?

```
POST /orders
   │
   ├── Redis GET      2ms
   ├── PostgreSQL    15ms
   └── payments-api  80ms
```

### How the application produces it

```ts
import './otel';
```

Usually your application has an initialization file like `otel.ts`.
That file initializes OpenTelemetry.

Conceptually:

```
Application
    │
    ├── HTTP instrumentation
    ├── DB instrumentation
    ├── Redis instrumentation
    └── custom spans
             │
             ▼
       OpenTelemetry
```

---

## 5. OTLP and the Collector

### OTLP

```
orders-api
orders-worker
payments-api
       │
       │ OTLP/HTTP
       │ :4318
       ▼
otel-collector
```

**OTLP** means **OpenTelemetry Protocol**. It's the protocol used to send
telemetry data.

So the application might send to:

```
http://otel-collector:4318
```

### Why have an OTel Collector?

You could theoretically have:

```
orders-api ──────────► Tempo
payments-api ────────► Tempo
worker ───────────────► Tempo
```

But that's not ideal.

Instead:

```
orders-api ──┐
worker ──────┼──► OTel Collector
payments ────┘
                    │
                    ├── Tempo
                    └── Prometheus/etc.
```

The collector becomes a central telemetry processing layer.

It can:

```
receive
  ↓
filter
  ↓
modify
  ↓
batch
  ↓
export
```

---

## 6. Where the signals are stored

```
Tempo      → traces
Prometheus → metrics
Loki       → logs
```

### Prometheus — metrics

Prometheus stores metrics.

```
http_requests_total
http_request_duration_seconds
container_cpu_usage
container_memory_usage
redis_connected_clients
postgres_connections
```

Prometheus works primarily using a **pull model**. It periodically asks:

> "Hey exporter, give me your metrics."

```
Prometheus
    │
    │ GET /metrics
    ▼
node-exporter
```

…every 10 seconds.

### Exporters

**node-exporter** — provides machine/host metrics:

```
CPU
memory
disk
network
```

**postgres-exporter:**

```
Postgres connections
queries
locks
transactions
```

**redis-exporter:**

```
Redis memory
commands
connections
keys
```

**cAdvisor:**

```
container CPU
container memory
container network
```

So the path looks like:

```
Postgres
    ↓
postgres-exporter
    ↓
Prometheus
```

### Tempo — traces

Tempo stores traces.

### Loki — logs

Loki is your log storage system.

Your application writes logs:

```json
{
  "level": "error",
  "service": "orders-api",
  "trace_id": "abc123",
  "message": "payment failed"
}
```

Those logs eventually go:

```
Application
    │
    ▼
stdout
    │
    ▼
Docker
    │
    ▼
Alloy
    │
    ▼
Loki
```

### Why logs go through stdout

In containerized applications, it's common for applications to write logs to
`stdout` / `stderr` rather than directly managing log files.

Docker collects those logs. Then a log collector can read them.

This follows the container philosophy:

> Application writes logs; infrastructure handles collection.

### Alloy

Alloy is your telemetry/log collection agent.

```
Docker containers
       │
       ▼
     Alloy
       │
       ▼
     Loki
```

Alloy reads container logs and processes them.

---

## 7. Grafana: the query plane

Grafana is the UI for querying and visualizing your observability data —
metrics, traces, and logs.

```
Grafana
   │
   ├──► Prometheus → 📊 Metrics
   │
   ├──► Tempo      → 🔍 Traces
   │
   └──► Loki       → 📝 Logs
```

So Grafana isn't generating or storing the metrics. It's primarily the place
where you look at and correlate the data stored in Prometheus, Tempo, and Loki.

And the most important relationship:

```
                 ┌───────────────┐
                 │   Grafana     │
                 └───────┬───────┘
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
       Prometheus       Tempo        Loki
        METRICS        TRACES        LOGS
            │            │            │
            └────────────┼────────────┘
                         │
                         ▼
                   OBSERVABILITY
```

---

## 8. Running and operating it

### k6

k6 is a load-testing tool.

Instead of manually sending `GET /orders`, you can simulate:

```
100 users
1,000 users
10,000 requests
```

```bash
docker compose run --rm k6 run /scripts/01-baseline.js
```

k6 generates traffic:

```
k6
 │
 │ HTTP
 ▼
orders-api
```

Now your observability stack has real traffic to observe.

### Why load testing is useful here

Because an observability system becomes much more interesting under load.

```
CPU ↑
Memory ↑
Requests ↑
Latency ↑
Errors ↑
Redis operations ↑
DB queries ↑
```

And then you use:

```
Prometheus → metrics
Tempo → traces
Loki → logs
```

### make verify

It likely runs automated checks such as:

- Is Postgres healthy?
- Is Redis healthy?
- Is API responding?
- Is Tempo responding?
- Is Prometheus responding?
- Is Grafana responding?
- Are telemetry signals flowing?

The important concept is:

> Don't manually check 15 containers every time. Automate the verification.

### make heal

Your project appears to intentionally introduce "pathologies" or failures:

```
slow database
high CPU
Redis issue
service failure
```

`make heal` probably disables those test failures and restores the normal state.

This is useful for demonstrating:

```
problem
  ↓
observe
  ↓
investigate
  ↓
fix
  ↓
verify
```

---

## 9. The complete picture

Putting every piece together:

```
                 REQUEST
                    │
                    ▼
              orders-api
             /     |      \
            /      |       \
         Redis   Postgres  payments
           │        │         │
           └────────┴─────────┘
                    │
                    │ telemetry
                    ▼
             OTel Collector
              /     |      \
             /      |       \
        Metrics    Traces    Logs
           │         │         │
           ▼         ▼         ▼
      Prometheus   Tempo     Loki
           \         |         /
            \        |        /
             └──── Grafana ──┘
```

And the key idea is:

```
Application
    ↓
generates telemetry
    ↓
collectors/processors
    ↓
storage
    ↓
Grafana
    ↓
human investigation
```

Including the collection agents, the full path is:

```
         APPLICATION
              │
              │ produces activity
              ▼
          TELEMETRY
              │
              ▼
        OTel / Alloy
         COLLECTION
              │
       ┌──────┼──────┐
       ▼      ▼      ▼
    Metrics Traces  Logs
       │      │      │
       ▼      ▼      ▼
   Prometheus Tempo  Loki
       │      │      │
       └──────┼──────┘
              ▼
           Grafana
              │
              ▼
        HUMAN / DEVELOPER
```

---

## If you remember only 8 things

| Component | Think of it as | Why we use it |
|---|---|---|
| **orders-api** | Main application | Business logic |
| **payments-api** | Separate service | Demonstrates distributed tracing |
| **Postgres** | Permanent database | Store business data |
| **Redis** | Fast memory + queue | Cache + background jobs |
| **orders-worker** | Background process | Async work |
| **OpenTelemetry** | Telemetry standard | Generate/transport traces & metrics |
| **Prometheus / Tempo / Loki** | Metrics / Traces / Logs storage | Store the three observability signals |
| **Grafana** | Investigation UI | Correlate everything |

---

## Why this architecture is valuable

The entire setup teaches you something much bigger than Docker.

**You're learning how a production application is observed.**
