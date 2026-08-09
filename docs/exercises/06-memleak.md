# Exercise 6 — `memLeak`: the metric that lies to you

**The clearest demonstration in the lab of a metric that is technically correct
and completely misleading.**

**Run**

```bash
docker compose run --rm k6 run /scripts/08-memleak.js
```

45 s healthy → 120 s **off-heap** leak → 30 s heal → 120 s **on-heap** leak.

---

## Look here

**USE dashboard**, two panels side by side:

- **"Memory by container"** (from `docker_stats` — what the kernel gave us)
- **"V8 heap used"** (from the Node runtime — what the app thinks it used)

---

## Phase 1 — `mode: "buffer"` (off-heap)

Measured on this stack:

```
container memory   162 MB  →  344 MB     climbing toward the 512 MB limit
v8js heap used     FLAT                  completely unmoved
```

Confirmed a second way, from the app's own `/admin/pathologies`:

```
before:  rss=121.1MB  heap=30.5MB  external=5.1MB    retained=0
after :  rss=221.8MB  heap=27.6MB  external=105.1MB  retained=100MB
```

`heapUsed` went **down**. `external` absorbed the entire 100 MB.

**Why:** Node `Buffer`s are allocated **outside** the V8 heap. `heapUsed` is a
measurement of the V8 heap, and it is reporting that number perfectly
accurately. It is simply not measuring where the leak is.

**The consequence:** a memory dashboard built on `heapUsed` — which is what most
Node dashboards show, and what most Node memory alerts fire on — reports a
completely healthy process while it marches toward an OOM kill. No alert. No
warning. Just a restart at 3 a.m. and a "memory leak" you cannot find, because
your graph insists there isn't one.

## Phase 2 — `mode: "heap"` (on-heap)

```
container memory   122 MB → 274 MB
v8js heap used      27 MB → 161 MB      ← now it moves
```

The case everyone pictures, and the only one heap metrics catch.

---

## The alert was written with this in mind

From [alerts.yml](../../observability/prometheus/rules/alerts.yml):

```promql
container_memory_usage_total_bytes / container_memory_usage_limit_bytes > 0.85
```

Measured against the **container limit**, not against heap. That is not a
stylistic preference — an alert written against `heapUsed` would have been
silent through all of Phase 1.

> **Alert at the boundary that actually kills you.**

---

## RSS lags heap, and that is real too

Run `make heal` and watch. The retained objects are freed immediately, but
container memory comes down more slowly.

V8 does not hand freed pages back to the OS eagerly. `POST /admin/memory/release`
calls `global.gc()` (enabled via `NODE_OPTIONS=--expose-gc`) which speeds this
up, but the gap between "heap freed" and "RSS returned" is genuine.

**This is why RSS alone is a poor *leak* signal** — it is lumpy and lags. RSS is
the right signal for "am I about to be OOM-killed"; the trend in
`retained`/heap is the right signal for "am I leaking". Different questions,
different metrics.

---

## Why this generalises beyond Node

Every runtime has memory it does not count in its own "heap" number:

| Runtime | Invisible to the runtime's heap metric |
|---|---|
| Node | `Buffer`, `ArrayBuffer`, native addons |
| JVM | direct/off-heap `ByteBuffer`, metaspace, thread stacks |
| Go | cgo allocations |
| Python | C extension allocations (numpy, lxml, …) |

**The rule:** measure memory at the boundary that terminates your process — the
container limit — not at the boundary your runtime finds convenient to report.
Use the runtime metric to *diagnose* a leak; use the container metric to *detect*
one.

---

## Takeaway

1. A metric can be **accurate and useless** at the same time. "Is this number
   correct?" and "is this number measuring the thing I care about?" are
   different questions, and only the second one matters.
2. **Alert on the boundary that kills you.**
3. When two metrics that "should" agree disagree, **that gap is information** —
   here it tells you precisely *what kind* of leak you have, which tells you
   where to look in the code.

**Heal:** `make heal`
