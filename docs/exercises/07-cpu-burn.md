# Exercise 7 — `cpuBurn`: CPU vs queueing vs slow dependency

**Run**

```bash
docker compose run --rm k6 run /scripts/07-cpu-burn.js
```

60 s healthy → 180 s burning 200 ms of CPU per request → heal.

---

## The question this exercise answers

Three very different problems all present identically as *"latency is up"*. This
is the fingerprint that separates them — and getting it wrong is expensive,
because the fixes share nothing.

| | Container CPU | Event-loop delay | DB / cache | Trace shape |
|---|---|---|---|---|
| **CPU-bound** *(this exercise)* | **HIGH** | **HIGH** | idle | long span, no children, no gaps |
| **Queueing** *(pool saturation)* | LOW | low | idle | **gap** before the DB span |
| **Slow dependency** *([ex. 5](05-slow-dependency.md))* | LOW | normal | idle | long **child** span, another service |

**Low CPU with high latency is the most informative combination in that table** —
it rules out "we need bigger machines", which is the answer people reach for
first and the one that would waste the most money.

---

## Look here

**USE dashboard**

1. **"CPU utilisation by container"** — `obslab-orders-api` climbs hard.
2. **"Event loop delay (p99)"** — climbs with it. This is the Node saturation
   metric, and it is more diagnostic than CPU%.
3. **Postgres and Redis panels** — flat. Nothing downstream is being asked to do
   more work. Whatever is happening is happening *in our process*.

**RED dashboard** — p50 and p99 both rise.

**Trace** — one long span, no slow children, no gaps. Time is being *spent*, not
*waited*.

---

## The Node-specific lesson

`cpuBurn` blocks the **event loop**.

Watch `/products` degrade — an endpoint doing nothing expensive at all. It is
slow because it cannot even be *picked up*: the single thread is busy.

**In Node, one hot endpoint degrades every endpoint in the process.** There is no
"only the expensive route is affected", the way there would be in a
thread-per-request runtime. This is why:

- **"Add more CPU" does not help.** Node cannot use a second core for your
  handler. You need to do less work, move it off the request path, or run more
  processes.
- **Event-loop delay belongs on your dashboard next to CPU, not instead of it.**
  The pair is what makes the diagnosis:

| CPU | Event-loop delay | Meaning |
|---|---|---|
| high | high | genuinely compute-bound — optimise or shard |
| low | high | blocked on something **synchronous** — a sync fs call, a huge `JSON.parse`, a regex backtracking |
| high | low | busy but healthy — work is spread across processes |

That middle row is the one that surprises people. High delay with *low* CPU means
you are not doing much work, you are just doing it in a way that refuses to
yield.

---

## Try it: prove the diagnosis

```bash
# CPU-bound: CPU high, event loop high
curl -XPOST localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"cpuBurn":{"enabled":true,"ms":200}}'

# vs. slow dependency: CPU low, event loop normal, same latency symptom
make heal
curl -XPOST localhost:8080/admin/pathologies -H 'content-type: application/json' \
  -d '{"slowDependency":{"enabled":true,"ms":2000}}'
```

Both make latency terrible. Compare the CPU and event-loop panels. **The latency
graph cannot tell them apart; the saturation metrics can, in one glance.**

---

## Takeaway

1. **"Latency is up" is a symptom, not a diagnosis.** Always ask *where the time
   goes* before deciding what to fix.
2. **Saturation beats utilisation.** Event-loop delay tells you more than CPU%
   for a Node service, because it measures *waiting*, not *busyness*.
3. **In Node, blocking is contagious across every request in the process.**

**Heal:** `make heal`
