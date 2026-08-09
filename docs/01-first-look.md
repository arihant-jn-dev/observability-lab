# What to look at first, in order

The triage runbook. Follow it top to bottom. The order is the point — each step
narrows the search space for the next, and skipping ahead is how people spend an
hour reading logs for a problem that was visible in one graph.

**Grafana: http://localhost:3300** (no login)

---

## 0. Before anything: is it real?

Two questions, ten seconds, and they save you from a surprising share of
false starts.

**"Is the monitoring itself broken?"**
A flat graph and a dead pipeline look identical. Check http://localhost:9090/targets
— if the collector is down, every app graph is lying by omission.

**"Did *anything* change?"**
Deploys, config flips, feature flags, traffic shifts. In this lab: check the
**Active lab pathologies** panel at the bottom of the RED dashboard. More real
incidents are explained by "someone changed something 20 minutes ago" than by
every other cause combined.

---

## 1. RATE — is traffic normal?

**RED dashboard → "Requests / sec by route"**

Check this *before* errors or latency, because it reframes everything below it.

- **Traffic dropped to near zero** → the problem is upstream of you, or you are
  hard-down. Note that error rate and latency will look *excellent* — there are
  no requests to fail or be slow. A drop in traffic is the one failure that
  makes every other graph look healthy.
- **Traffic spiked** → you may just be overloaded. Everything downstream
  (latency, saturation) may be a *symptom* of the spike, not an independent fault.
- **Traffic normal** → good, the change is inside your service. Continue.

> A drop is as alarming as a spike. Most dashboards are built to notice spikes.

---

## 2. ERRORS — is it failing, or just slow?

**RED dashboard → "Error rate" stat, then "Error ratio by route"**

This is the fork in the road, and it determines everything you do next:

- **Errors elevated** → availability problem. Go to step 3.
- **Errors flat, latency up** → performance problem. Skip to step 4.

Then immediately split by route. **A service-wide error rate of 2% is often one
endpoint at 100%.** Averaging across routes hides precisely the thing you are
looking for.

Also split by status class — the RED dashboard's "Throughput by status code"
panel does this:

- **5xx** → yours.
- **4xx** → usually a *caller* problem: someone deployed a bad client, sent
  malformed input, or lost their auth token. Real, but often not your incident.
- **402/403/409** and similar → may be entirely legitimate business outcomes.
  In this lab, `/checkout` returns 402 for amounts over $5,000 *by design*.
  Learning to tell "expected failure" from "incident" is half of alerting.

---

## 3. Errors: find the CAUSE, not the count

You know how many and which route. You do not know why — and **no metric can
tell you**, because the reason was discarded when the counter was incremented.

**Metric → trace → log.** This is the core workflow of the whole lab:

1. On **"p99 by route"**, click an **exemplar diamond** under the failing route.
   You are now looking at one specific failed request.
2. In the trace, find the span with the error. Note *how far the request got* —
   which is itself diagnostic: failing before the DB call and failing after it
   are different bugs.
3. Click **"Logs for this span"**. Loki filters to that `trace_id` and returns
   the actual sentence — the exception, the constraint violation, the reason.

Each signal answers a question the previous one couldn't:

> **which route** (metric) → **which request and which step** (trace) →
> **why** (log)

---

## 4. Slow: WHERE is the time going?

Open a slow trace (exemplar on the p99 line) and read the waterfall. There are
only four shapes, and they are easy to tell apart:

| Trace shape | Meaning | Confirm on the USE dashboard |
|---|---|---|
| One long span, **no slow children** | Your own code is doing work | CPU high, event-loop delay high |
| Long **child span in another service** | Dependency is slow | "Outbound call latency" — both lines up |
| **A gap before** a span starts | Queueing / waiting for a resource | `db_pool_connections{state="waiting"} > 0` |
| **Many repeated** child spans | N+1 | "queries/sec" up, query *duration* flat |

That table is most of performance debugging. The distinction between rows 1, 2
and 3 is invisible in metrics — all three produce an identical "p99 went up"
graph — and unmissable in a trace.

---

## 5. Confirm the mechanism on USE

RED told you the service is unhealthy. USE tells you *which resource* is why.
**USE dashboard**, in this order:

1. **`db_pool_connections{state="waiting"}`** — the most under-appreciated
   series here. Above zero means requests are queueing for a connection:
   nothing failed, the DB is idle, CPU is flat, everything is slow. This is the
   most commonly misdiagnosed shape of "slow" in the whole lab.
2. **Event loop delay p99** — Node's real saturation metric. High delay + low
   CPU = blocked on something synchronous. High delay + high CPU = genuinely
   compute-bound. Remember: in Node this affects *every* request in the process,
   so one hot endpoint makes the whole service look sick.
3. **Container memory vs limit** — approaching the limit means an imminent OOM
   kill and a restart that will erase your evidence.
4. **Cache hit ratio** — a sudden drop is the leading indicator for a database
   about to receive 20× its normal load.
5. **Postgres blks_read** — climbing means reads are going to disk that used to
   be served from memory.

**Saturation matters more than utilisation.** A resource at 70% with a queue is
in more trouble than one at 95% with none. Queueing is what turns latency
non-linear; utilisation alone is just a number.

---

## 6. Narrow it in time

Once you know *what*, pin down *when* — the "when" usually names the cause.

- Zoom the dashboard to the transition, not the whole outage. The interesting
  information is at the edge, where things changed.
- Line the start up against deploys, config changes, cron jobs, traffic shifts.
- Beware **scrape-interval blindness**: Prometheus samples every 10 s here.
  Anything shorter than that may be invisible in metrics but plainly present in
  traces, which record every request. If metrics say nothing happened but users
  say it did, believe the users and go to the traces.

---

## The short version

```
0. Is the monitoring OK? Did anything change?
1. RATE      — traffic normal? a drop makes everything else look healthy
2. ERRORS    — failing or slow? split by route, then by status class
3. if failing  → metric → trace → log     (which route → which step → why)
4. if slow     → read the trace waterfall shape (4 shapes, see table)
5. USE       — confirm the mechanism; check SATURATION before utilisation
6. Zoom to the transition and align it with changes
```

---

## The two habits that matter most

**Form a hypothesis before you look.** "I think the DB is slow" makes the next
graph a test with a yes/no answer. Scrolling dashboards hoping something looks
wrong is how an hour disappears — there is always something that looks a bit
wrong.

**Know your normal.** Run [`01-baseline.js`](../load/k6/01-baseline.js) and
write down p50, p99, cache hit ratio, and queue lag while healthy. You cannot
recognise abnormal without it, and 3 a.m. is the worst possible time to work out
whether 180 ms is bad.

---

Next: [02-percentiles.md](02-percentiles.md) ·
[03-signals.md](03-signals.md) ·
[exercises](exercises/)
