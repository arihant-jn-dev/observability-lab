# Guided exercises

Each one: **run this → look here → here's what you should see and why.**

Do them in order the first time. Each builds on a distinction the previous one
set up, and several are explicitly designed to be *compared* with each other.

**Before anything:** run the baseline and write down your normal.

```bash
docker compose run --rm k6 run /scripts/01-baseline.js
```

You cannot recognise abnormal without it.

---

| # | Exercise | The lesson | Signal that cracks it |
|---|---|---|---|
| 1 | [`slow`](01-slow.md) | p50+p99 together = general slowdown. Which *route* matters. | Metrics → trace shape |
| 2 | [`errorRate`](02-error-rate.md) | **The full three-signal walk.** Which route → which request → why. | All three |
| 3 | [`nPlusOne`](03-nplusone.md) | Damage in *round-trip count*, not duration. Invisible to every duration metric. | **Trace only** |
| 4 | [`flushCache`](04-flush-cache.md) | A performance component that is secretly load-bearing. Plus scrape-interval blindness. | Metrics (USE chain) |
| 5 | [`slowDependency`](05-slow-dependency.md) | Identical graph to #1, opposite cause. Blame needs a trace. | **Trace only** |
| 6 | [`memLeak`](06-memleak.md) | A metric that is accurate and useless. Heap vs container memory. | Metrics (the right one) |
| 7 | [`cpuBurn`](07-cpu-burn.md) | CPU vs queueing vs dependency — three causes, one symptom. | Saturation metrics |
| — | [cardinality bomb](../04-cardinality.md) | Taking down your monitoring with your own instrumentation. | Meta |

---

## Pairs worth comparing directly

The comparisons teach more than either exercise alone:

- **1 vs 5** — identical latency graphs, completely different causes. This pair
  is the single best argument for tracing in the whole lab.
- **3 vs everything** — the only failure here that *no* metric can find.
- **6 phase 1 vs phase 2** — the same word "leak", visible in different places.
- **7 vs 4** — high CPU vs zero CPU, both producing "it's slow".

---

## Reset between exercises

```bash
make heal      # all pathologies off + release leaked memory
```

Every k6 scenario also heals in `teardown()`, but `make heal` is the safety net
when you have been poking at `/admin` by hand.

If a pathology seems stuck, check the **Active lab pathologies** panel at the
bottom of the RED dashboard. It exists so you never debug a symptom you injected
20 minutes ago and forgot about.

---

## Then read

- [How this project was built](../00-how-this-was-built.md) — the full walkthrough
- [What to look at first](../01-first-look.md) — the triage runbook
- [Why percentiles beat averages](../02-percentiles.md) — with data from this stack
- [Metrics vs traces vs logs](../03-signals.md) — what each is bad at
- [The cardinality trap](../04-cardinality.md) — including one this lab hit by accident
- [Which alerts are worth waking up for](../05-alerts.md)
