# Metrics, traces, logs — what each answers, and what each is bad at

Three signals is not redundancy. Each one makes a different trade against cost,
and each is *structurally incapable* of answering the others' questions.

---

## The one-line version

| Signal | Answers | Cannot answer | Cost model |
|---|---|---|---|
| **Metrics** | How much? How often? How bad? Since when? | Which request? Why? | Constant per *series* — traffic-independent |
| **Traces** | Where did time go? What called what? | How often? What's the trend? | Per *request* — scales with traffic |
| **Logs** | What exactly happened, in words? | Anything aggregate, cheaply | Per *line* — scales worst of all |

---

## Metrics

**What they are:** numbers aggregated over time, sliced by a small set of
bounded labels.

**Good at:**
- Cheap enough to keep for *every* request, forever. This is the whole point:
  metrics are the only signal you can afford to have complete coverage of.
- Trends, comparisons, seasonality — "is this worse than last Tuesday?"
- Alerting. Alert rules need stable, cheap, complete data.
- Answering "when did this start?" precisely.

**Structurally bad at:**
- **Any question about an individual request.** Aggregation *discards* which
  request contributed what. The information is not hidden — it is gone.
- **High-cardinality dimensions.** Every distinct label combination is a new
  stored series. Adding `user_id` means one series per user, forever. See
  [04-cardinality.md](04-cardinality.md).
- **Causes.** A counter can tell you 30% of requests failed. It can never tell
  you the constraint that was violated.
- **Anything shorter than the scrape interval.** We scrape every 10 s; a 5 s
  outage may leave no trace in metrics at all.

**The failure mode to internalise:** you will want to add "just one more label"
to answer a specific question. That instinct is nearly always metrics being
asked to do a trace's job.

---

## Traces

**What they are:** a record of one request's journey — every span, its duration,
its parent, its attributes — including across service and process boundaries.

**Good at:**
- **Where the time went.** The single question metrics can never answer.
- **Causal structure.** What called what, in what order, and what waited on what.
- **Crossing boundaries.** A trace in this lab spans `orders-api` →
  `payments-api` → and (via manual propagation) the worker, in a different
  process, seconds later.
- **High-cardinality attributes.** `order_id`, `customer_id`, raw URLs — all
  fine. Traces store per-event, so there is no series to explode.
- **Structural problems.** N+1 is invisible to every duration metric and
  glaringly obvious in a waterfall.

**Structurally bad at:**
- **Aggregate questions.** "What's my error rate?" over traces means scanning
  every trace — expensive and slow. (Hence the spanmetrics connector, which
  pre-computes RED metrics *from* traces.)
- **Being complete at scale.** Production systems sample — often 1%. Your
  specific bad request may simply not have been kept. This lab samples 100%
  because it is a lab.
- **Trends.** Tempo is a key-value store from trace_id → trace. It does almost
  no indexing, which is exactly what makes it affordable. "Find all traces
  where…" is a brute-force scan.
- **Being found without a starting point.** Searching Tempo blind is slow and
  unrewarding, and is why people conclude "tracing is useless". The intended
  workflow is metrics-first: find *when* and *which route* in Prometheus, grab a
  `trace_id` from an exemplar, then ask Tempo for that one trace.

---

## Logs

**What they are:** timestamped lines of text. Ideally structured JSON.

**Good at:**
- **The actual reason.** `duplicate key violates unique constraint orders_pkey`.
  No metric or trace shape contains that sentence.
- **Detail you didn't plan for.** You cannot retroactively add a span attribute,
  but a log line you wrote six months ago is still there.
- **Surviving the app's death.** Because our app writes to stdout and Docker
  captures it, logs describing an OOM kill survive the OOM kill. An app that
  pushes its own telemetry loses exactly the data about its own failure.
- **Audit and compliance** — things that must be exactly, individually recorded.

**Structurally bad at:**
- **Cost.** The most expensive signal per unit of insight, by a wide margin.
- **Aggregation.** "What's my p99?" from logs means parsing every line.
  Technically possible, absurdly expensive.
- **Being found.** Without `trace_id` correlation, finding *the* log lines for
  *the* failed request among millions is genuinely hard.
- **Cardinality — again, but differently.** In Loki, labels are the index. A
  high-cardinality *label* creates one stream per value and destroys the
  database. This is why [our Alloy config](../observability/alloy/config.alloy)
  attaches `trace_id` as **structured metadata**, not as a label.

---

## Why the correlation matters more than any one signal

Each signal answers exactly one question in the chain, and the chain only works
because they are linked:

```
Prometheus:  "5% of /checkout is failing, starting 14:32"
                 │  exemplar → trace_id
                 ▼
Tempo:       "this request failed at the payments-api span, after 2.1s"
                 │  trace_id → log filter
                 ▼
Loki:        "connection refused: payments-api:8081"
```

**Which route → which step → why.** Three databases, one workflow.

Verified working in this lab: one `trace_id` returns 3 log lines, including
`job processed` from the **worker** — a different process entirely.

---

## Which one do I reach for?

| Question | Signal |
|---|---|
| Is something wrong right now? | Metrics |
| Is this worse than yesterday? | Metrics |
| Should I be paged? | Metrics (only) |
| Which endpoint is affected? | Metrics |
| Why is *this* request slow? | Trace |
| What is my service waiting on? | Trace |
| Did the retry actually happen? | Trace |
| What was the exact error? | Log |
| What did we do for customer 4471 at 09:12? | Log (or trace by attribute) |
| How many customers were affected? | Metrics |

---

## The economic argument, in one paragraph

You cannot afford full-fidelity logs and traces for every request at scale, and
you do not need them. Metrics give **complete coverage, no detail**. Traces give
**deep detail, sampled coverage**. Logs give **exact words, at the highest cost
per byte**. A working observability practice uses the cheap complete signal to
find *where* to look, then spends the expensive detailed signals only there.
Systems that skip the first step burn enormous amounts of money and still can't
answer questions.

---

## Where each signal sits in this lab

| | Emitted by | Shipped by | Stored in | Seen at |
|---|---|---|---|---|
| Metrics | OTel SDK + hand-written | OTLP → Collector | Prometheus | :9090 / Grafana |
| Traces | OTel auto-instrumentation | OTLP → Collector | Tempo | Grafana |
| Logs | Pino → stdout | Docker → Alloy | Loki | Grafana |

Note the logs path deliberately does **not** go through the app→OTLP route.
stdout is the most robust thing the app can do; see the comment at the top of
[config.alloy](../observability/alloy/config.alloy).

---

Related: [01-first-look.md](01-first-look.md) ·
[04-cardinality.md](04-cardinality.md) · [05-alerts.md](05-alerts.md)
