# Exercise 2 — `errorRate`: finding the cause, not the count

**The most important exercise in the lab.** It is the full three-signal walk.

**Run**

```bash
docker compose run --rm k6 run /scripts/03-errors.js
```

60 s healthy → 180 s at 30% failures → heal.

---

## Look here, in this order

### 1. Metrics — *which route*

**RED dashboard**

- **"Error rate"** stat turns red.
- **"Error ratio by route"** — which endpoints are affected.
- **"Throughput by status code"** — the 5xx band appears.

You now know **when** and **where**. You do **not** know why, and no amount of
staring at these graphs will tell you — the reason was discarded the moment the
counter was incremented. That is not a gap in the dashboard; it is what
aggregation *is*.

### 2. Traces — *which request, which step*

On **"p99 by route"**, click an **exemplar diamond** under a failing route.

You are now looking at one specific failed request. Note how far it got before
failing — failing *before* the DB call and *after* it are different bugs.

### 3. Logs — *why*

In the trace view, click **"Logs for this span"**.

Loki filters to that `trace_id` and returns the actual sentence:

```json
{"level":"error","msg":"injected failure","pathology":"errorRate","trace_id":"..."}
```

---

## Also watch: the alert

http://localhost:9090/alerts

`HighErrorRate` goes **PENDING**, then **FIRING** about two minutes later.
Verified on this stack: it fired at *30.17% of requests are failing*.

That delay is the `for: 2m` clause, and it is deliberate — it is what stops a
10-second blip from waking someone at 3 a.m. Watch it happen so the trade-off
between fast detection and false positives stops being abstract.

---

## Takeaway

Each signal answers exactly one question in the chain:

> **which route** (metric) → **which request and which step** (trace) →
> **why** (log)

Three databases, one workflow. The links between them —
[exemplars and derived fields](../../observability/grafana/provisioning/datasources/datasources.yaml)
— are what turn three storage systems into an observability *system*. Without
them you have three search boxes and a lot of manual timestamp matching.

**Heal:** `make heal`
