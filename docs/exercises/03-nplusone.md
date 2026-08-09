# Exercise 3 — `nPlusOne`: the failure metrics cannot see

**This is the exercise that justifies tracing existing at all.**

**Run**

```bash
docker compose run --rm k6 run /scripts/04-nplusone.js
```

60 s healthy → 180 s with N+1 on `/orders` → heal.

---

## First, confirm it with your own eyes

The endpoint reports its own query count:

```bash
curl -s 'localhost:8080/orders?limit=50' | python3 -c 'import sys,json;print(json.load(sys.stdin)["queryCount"])'
```

**Healthy: `2`. With N+1: `51`.** Measured, both branches returning byte-identical JSON.

---

## What stays completely normal

This is the important half of the exercise.

| Signal | During N+1 |
|---|---|
| Error rate | **0%** — every response is a correct 200 |
| DB query duration p99 | **flat** — each query is sub-ms and index-backed |
| Postgres slow query log | **empty** — `log_min_duration_statement=200ms`, nothing comes close |
| CPU | barely moves |

We indexed `order_items.order_id` **on purpose**. N+1 is not a slow-query
problem, and treating it as one is why it survives so long in real codebases.

## What actually changes

**USE dashboard → "Database query duration"** — look at the *second* line,
`queries/sec`. It jumps ~25×. The duration line does not move.

The damage is entirely in the **count of round trips**, not the duration of any
one of them. Every duration-based tool is structurally blind to it.

---

## Now open a trace

RED dashboard → exemplar on `/orders` → the trace.

Fifty identical `pg.query:SELECT ordersdb` spans marching down the screen in a
staircase. It takes about one second to diagnose, and no metric on any dashboard
could have shown you that shape.

*(This is also why `enhancedDatabaseReporting: true` is set in
[otel.ts](../../services/orders-api/src/otel.ts) — it puts the actual SQL on the
span, so you can see it is the same statement fifty times.)*

---

## Takeaway

**Metrics answer "how much / how often". They cannot answer "what shape was
this request".**

Anything whose damage is *structural* rather than *statistical* needs a trace:

- N+1 queries
- a retry loop that succeeds on attempt 5
- sequential calls that should have been parallel
- a cache being checked *after* the expensive call instead of before

All of these look completely healthy in aggregate and are obvious in a
waterfall.

**Heal:** `make heal`
