# Why percentiles beat averages

*(with real numbers measured on this stack — you can reproduce every one)*

---

## The experiment

Traffic split roughly 90% `/orders` and 10% `/products`. Then `/products` — and
only `/products` — was given 3 seconds of injected latency. Nothing else changed.

Here is what the **service-wide** latency metrics reported:

| | mean | p50 | p95 | p99 |
|---|---|---|---|---|
| **healthy** | 1.6 ms | 2.5 ms | 4.8 ms | 5.0 ms |
| **10% of requests slow** | **310.8 ms** | **2.9 ms** | 3783 ms | 4757 ms |

Reproduce it:

```bash
make heal
# baseline: 9 parts /orders to 1 part /products
while true; do
  for i in $(seq 1 9); do curl -s -o /dev/null 'localhost:8080/orders?limit=10'; done
  curl -s -o /dev/null 'localhost:8080/products?limit=10'
done
# in another shell, after ~90s:
curl -XPOST localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"slow":{"enabled":true,"ms":3000,"route":"/products"}}'
```

---

## Three things that table proves

### 1. The mean describes nobody

The mean says **310.8 ms**.

Not one request took 310 ms. Requests took either **~3 ms** or **~3000 ms**.
310 ms is a number sitting in the empty gap between two populations, describing
neither of them. It is the arithmetic centre of a distribution that has nothing
in its centre.

This is what "the average is meaningless for bimodal data" actually looks like.
And latency is *almost always* bimodal in practice — cache hit vs miss, warm vs
cold connection, fast path vs fallback, healthy replica vs sick one.

### 2. The mean is unactionable in both directions

Look at what the mean does as the *proportion* of slow requests changes, holding
the slowness constant at 3 s:

| % of requests slow | mean | p99 | Reality |
|---|---|---|---|
| 1% | ~33 ms | ~3000 ms | 1 in 100 users furious |
| 10% | ~310 ms | ~3000 ms | 1 in 10 users furious |
| 50% | ~1500 ms | ~3000 ms | half your users furious |

The mean moves smoothly and tells you *nothing about how many people are
affected or how badly*. A mean of 310 ms could be "everyone is slightly slow"
or "10% are catastrophically slow" — completely different incidents with
completely different causes, and the mean cannot distinguish them.

p50 and p99 **together** distinguish them instantly:

- **p50 up, p99 up** → everyone is slower. A general regression.
- **p50 flat, p99 up** → a *subset* is slow. Look for what makes those requests
  different: one route, one shard, one customer, one cold cache.

Our data is the second case, unmistakably: p50 moved 2.5 → 2.9 ms (+16%) while
p99 moved 5 → 4757 ms (**+95,000%**).

### 3. p99 is not an edge case — it is your busiest users

"p99 is only 1% of requests, why care?"

At 1,000 requests/second, p99 is **10 requests every second**. Over an hour,
36,000 bad experiences.

Worse: those requests are not randomly distributed across users. Slow requests
correlate with *doing more* — bigger carts, more history, more items — which
means your p99 disproportionately hits your **heaviest, most valuable users**.
The people most invested in your product get the worst experience, systematically.

And it compounds. If a page makes 20 API calls, the chance that *at least one*
hits your p99 is `1 - 0.99^20 ≈ 18%`. **A p99 of 5 s means nearly one in five
page loads has a 5-second component.** Per-request percentiles understate
per-*page* pain badly.

---

## So which numbers should be on the dashboard?

**p50, p95, p99 — always together.** The relationship between them is the
diagnosis; any one alone is nearly useless.

The RED dashboard plots the mean too, labelled `MEAN (the liar)`. It is there
deliberately, so you can watch it fail to react during the exercises.

Add a **heatmap** as well (it is on the RED dashboard). Percentiles are a
lossy 3-number summary of the distribution; the heatmap shows the actual shape.
Two distinct bands = two populations = go find what separates them. No
percentile can show you that.

---

## The trap: you cannot average percentiles

This is the most common percentile mistake in production, and it is silent.

```promql
# WRONG — averaging pre-computed quantiles is mathematically meaningless
avg(p99_latency_by_instance)

# RIGHT — aggregate the raw buckets, THEN compute the quantile
histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))
```

The p99 of a set of p99s is not the p99 of anything. Ten instances each with
p99 = 100 ms do not give a fleet p99 of 100 ms — if one instance serves most of
the traffic, the real fleet p99 could be far worse.

This is exactly why Prometheus histograms ship **buckets** rather than
percentiles: buckets are additive across instances, percentiles are not. Every
`histogram_quantile` query in this lab sums the buckets first — `sum by (le)`
before the quantile, never after.

---

## The trap: buckets bound what you can know

A histogram can only answer questions its buckets are shaped for.

Our top bucket is 10 s ([metrics.ts](../services/orders-api/src/metrics.ts),
[collector config](../observability/otel-collector/config.yaml)). If real p99
were 30 s, `histogram_quantile` would report something near 10 s and be
**confidently wrong** — the value is interpolated within the last bucket, and
there is no data up there to interpolate from.

Check for this whenever a percentile looks suspiciously pinned:

```promql
# what fraction of requests land in the +Inf bucket (i.e. above your top bound)?
sum(rate(http_server_request_duration_seconds_bucket{le="+Inf"}[5m]))
  - sum(rate(http_server_request_duration_seconds_bucket{le="10"}[5m]))
```

If that is meaningfully above zero, your top bucket is too low and every
percentile near it is fiction.

---

## What to remember

1. **Never alert on a mean.** Our mean went from 1.6 ms to 310 ms while the
   typical user experienced no change — and would have shown the same 310 ms if
   *everyone* had been moderately slow.
2. **p50 flat + p99 up = a subset problem.** Go find what those requests share.
3. **p99 is 10 users/second at 1k rps**, concentrated among your heaviest users.
4. **Aggregate buckets, then compute quantiles.** Never average percentiles.
5. **Check your top bucket** before trusting any high percentile.

Related: [01-first-look.md](01-first-look.md) ·
[03-signals.md](03-signals.md) · [05-alerts.md](05-alerts.md)
