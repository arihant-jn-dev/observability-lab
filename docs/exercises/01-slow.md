# Exercise 1 — `slow`: "the site is slow"

**Run**

```bash
docker compose run --rm k6 run /scripts/02-slow.js
```

60 s healthy → 180 s with `/products` +900 ms → heal.

---

## Look here

**Grafana → RED — orders-api** (http://localhost:3300)

1. **"Latency percentiles"** — p50 *and* p99 both step up together.
2. **"p99 by route"** — only `/products` moves. `/orders` and `/checkout` are
   untouched.
3. **"Latency distribution" heatmap** — the band shifts upward *as a block*.
4. Click an **exemplar diamond** on the `/products` p99 line → opens the trace.

---

## What you should see, and why

**p50 and p99 moving together** means a whole population got slower — a general
regression, not a slow tail. Contrast with the
[percentiles experiment](../02-percentiles.md), where p50 stayed flat and only
p99 exploded; that shape means a *subset* is affected. Two very different
investigations, distinguishable at a glance once you know to look.

**Only one route is affected.** This is deliberate. "The service is slow" is
almost never true of every endpoint, and the actual skill is finding *which*
one. A service-wide p99 graph will show the damage; only the per-route breakdown
localises it.

**The trace shows a long span with no slow children.** Nothing is being waited
on — time is simply being spent inside the handler. That shape is the
fingerprint of *your own code* being slow.

Compare directly with [exercise 5](05-slow-dependency.md), which produces an
almost identical latency graph but a completely different trace: there, the time
sits in a child span owned by another service. **Same symptom, different cause,
and only the trace tells them apart.**

---

## Takeaway

A latency graph tells you *that* something is slow and *which route*. The
waterfall shape tells you *who is responsible*:

| Trace shape | Responsible |
|---|---|
| Long span, no slow children | Your code |
| Long child span, another service | Dependency |
| Gap before a span starts | Queueing for a resource |
| Many repeated child spans | N+1 |

**Heal:** `make heal`
