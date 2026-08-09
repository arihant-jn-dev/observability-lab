# Exercise 4 — `flushCache`: when a *performance* component becomes an *availability* one

**Run**

```bash
docker compose run --rm k6 run /scripts/05-flush-cache.js
```

90 s warming → **FLUSH under load** → 150 s cold → heal.

---

## Why `/products` is deliberately expensive

The cached query aggregates all 20,000 `order_items` rows to compute per-product
sales figures. Measured with `EXPLAIN ANALYZE`: **17.5 ms**.

That expense is the point. A cache in front of a 0.5 ms indexed lookup is a
strawman — flushing it changes nothing, and you would learn the *wrong* lesson.
Real caches sit in front of real work.

Measured on this stack:

```
cache HIT   ~2.4 ms median
cache MISS  ~12.6 ms median      ← 5x per-request penalty
```

---

## Look here

**RED dashboard**, then **USE dashboard**, in this order — the order *is* the
causal chain:

1. **RED → "Cache hit ratio"** — falls off a cliff at the moment of the flush.
   This is the **leading indicator**; everything below is downstream of it.
2. **USE → "Database query duration"**, second line, `queries/sec` — measured
   going from **~0.3/s to ~79/s**. Traffic that Redis was absorbing is now
   arriving at Postgres.
3. **USE → "Postgres: rows fetched vs returned"** — `tup_returned` climbs
   (~400/s measured).
4. **RED → "Latency percentiles"** — p99 rises, modestly.

---

## Now the honest part: what you will NOT see here

**The pool does not saturate. p99 does not blow out.** I tested this repeatedly
while building the lab, including with `PG_POOL_MAX=3` and 30 concurrent
readers. `db_pool_connections{state="waiting"}` stayed at **0** every time.

That is not a broken exercise — understanding *why* is worth more than a rigged
demo.

**The arithmetic.** With a 10-connection pool and 17.5 ms queries, the ceiling is

```
10 connections ÷ 0.0175 s = ~570 queries/sec
```

before anything queues. The flush produced ~79/s. **Not close.**

**The cache refills faster than you can watch.** There are only ~500 distinct
cache keys in this dataset. At a few hundred requests/second, every key is
repopulated within roughly a second. The "thundering herd" is over almost
immediately.

**And that exposes a genuinely important lesson:** the refill storm lasts about
one second. Prometheus scrapes every **10 seconds**. *The most violent moment of
this incident is literally invisible to your metrics.* If you want to see it,
you need the traces — which record every request — or a much shorter scrape
interval. This is **scrape-interval blindness**, and it is why "the graphs show
nothing" never means "nothing happened".

---

## So why does this take real systems down?

Change the numbers, not the mechanism:

| | This lab | A real service |
|---|---|---|
| Distinct cache keys | ~500 | millions |
| Refill time | ~1 second | minutes to hours |
| Miss cost | 17 ms | 50–500 ms |
| Pool ceiling | ~570 q/s | often far below peak demand |
| Peak demand | ~80 q/s | 10,000+ q/s |

With millions of keys the cache does **not** refill quickly, so the miss rate
stays high for a sustained period. Now demand exceeds the pool ceiling, requests
queue, latency goes non-linear, timeouts fire, clients retry — and **retries add
load to a system that is already over capacity**. That is the doom loop, and it
is why cache-flush incidents produce outages rather than slowdowns.

### Make it hurt (optional)

To see the full cascade, you must push demand past the pool ceiling:

```yaml
# docker-compose.yml, orders-api
PG_POOL_MAX: 2        # ceiling drops to ~114 q/s
CACHE_TTL_SECONDS: 5  # cache keeps going cold, so misses persist
```

```bash
docker compose up -d orders-api
docker compose run --rm k6 run /scripts/05-flush-cache.js
```

Now watch `db_pool_connections{state="waiting"}` go above zero, and p99 follow it.

---

## Takeaway

**"It's only a cache" is a statement about correctness, not about capacity.**

Every read path here falls back to Postgres, so losing Redis never returns a
wrong answer. But a component absorbing 98% of your reads is **load-bearing
infrastructure**, whatever the architecture diagram calls it.

Ask of every cache you own:

> If this emptied at peak traffic, can the thing behind it serve 100% of the
> load? For how long?

If the answer is no, your cache is not an optimisation — it is a **single point
of failure with good PR**.

The second lesson, equally important: **your monitoring has a resolution limit.**
A one-second event does not exist in ten-second metrics. Know your scrape
interval, and reach for traces when the timescale is shorter than it.

**Heal:** `make heal`
