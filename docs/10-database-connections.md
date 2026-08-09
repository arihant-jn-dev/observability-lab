# Database connections, pooling, and limits

How many connections can you open, what happens when you run out, and why the
answer is different for Postgres and MySQL.

Every number and error message below was produced on this lab's running stack.

**Contents**

1. [What a connection actually is](#1-what-a-connection-actually-is)
2. [Why we pool](#2-why-we-pool)
3. [Experiment 1 — pool queueing](#3-experiment-1--pool-queueing)
4. [Experiment 2 — hitting the server limit](#4-experiment-2--hitting-the-server-limit)
5. [Two limits, not one](#5-two-limits-not-one)
6. [The multiplication trap](#6-the-multiplication-trap)
7. [How to size a pool](#7-how-to-size-a-pool)
8. [MySQL specifically](#8-mysql-specifically)
9. [Postgres vs MySQL — why the limits differ](#9-postgres-vs-mysql--why-the-limits-differ)
10. [Observing this in the lab](#10-observing-this-in-the-lab)
11. [Diagnosing connection problems](#11-diagnosing-connection-problems)

---

## 1. What a connection actually is

A database connection is **a live TCP socket plus server-side state** — your
session, your transaction, your temp buffers, your prepared statements.

It is not free, and *how* it's not free differs by database:

| | Postgres | MySQL |
|---|---|---|
| Per connection | a whole **OS process** (`fork()`) | an **OS thread** |
| Memory each | ~5–10 MB | ~256 KB – 1 MB+ |
| Typical `max_connections` | 100 (default) | 151 (default) |
| Practical ceiling | few hundred → use PgBouncer | a few thousand |

**This single difference explains most of the advice you'll read about each.**
Postgres connections are expensive because each is a process; MySQL's are
cheaper because each is a thread.

Opening a connection also costs *time*: TCP handshake, authentication, TLS if
enabled, session setup. Typically 1–5 ms locally, 20–100 ms across a network.

---

## 2. Why we pool

Naive approach — open a connection per request:

```
request 1 ──► connect (30ms) ──► query (2ms) ──► close
request 2 ──► connect (30ms) ──► query (2ms) ──► close
```

You spend 30 ms of setup for 2 ms of work, and at 1,000 rps you'd try to open
1,000 connections/second. The database dies.

A **pool** keeps a small set of connections open and hands them out:

```
                    ┌─────────────────────┐
  request 1 ──┐     │   POOL (max = 10)   │
  request 2 ──┤     │                     │
  request 3 ──┼────►│  ■ ■ ■ ■ □ □ □ □ □ □│────► Postgres
  request 4 ──┤     │  in use    idle     │
  request N ──┘     └─────────────────────┘
                             ▲
                    if all 10 are busy,
                    request WAITS here
```

The critical behaviour: **when every connection is busy, new requests do not
fail — they queue.** That queue is invisible in database metrics (the DB isn't
busy) and invisible in CPU metrics (nobody is working). It shows up only as
latency.

In this lab, [`db.ts`](../services/orders-api/src/db.ts):

```ts
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,      // close idle connections after 30s
  connectionTimeoutMillis: 10_000, // give up waiting after 10s
});
```

`connectionTimeoutMillis` is the important safety valve: without it, a saturated
pool makes requests wait forever.

---

## 3. Experiment 1 — pool queueing

Pool of **3**, firing **9** concurrent queries that each take **1 second**:

```
Pool max=3. Firing 9 concurrent queries, each taking 1s.

  t=0.41s  total=3 idle=0 WAITING=6
  t=0.81s  total=3 idle=0 WAITING=6
  ✓ job 0 finished at t=1.03s
  ✓ job 2 finished at t=1.03s
  ✓ job 1 finished at t=1.03s
  t=1.21s  total=3 idle=0 WAITING=3
  t=2.01s  total=3 idle=0 WAITING=3
  ✓ job 3 finished at t=2.03s
  ✓ job 4 finished at t=2.03s
  ✓ job 5 finished at t=2.03s
  t=2.41s  total=3 idle=0 WAITING=0
  ✓ job 6 finished at t=3.05s
  ✓ job 7 finished at t=3.05s
  ✓ job 8 finished at t=3.05s

All 9 jobs done in 3.05s
```

Read what happened:

- Jobs finished in **three waves**: 1.03s, 2.03s, 3.05s
- `WAITING` went **6 → 3 → 0**
- Total time `3.05s` = `ceil(9 ÷ 3) × 1s`

**Jobs 6–8 took 3 seconds to complete a 1-second query.** Two thirds of their
latency was spent *waiting for a connection*, not doing work.

Now notice what the database would have reported during this: 3 active queries,
each taking exactly 1s, no slow queries, low CPU. **From the database's point of
view nothing was wrong.** The delay lived entirely in the application's pool.

This is why `db_pool_connections{state="waiting"}` is on the USE dashboard, and
why it's the most commonly misdiagnosed shape of "slow".

### The formula

```
throughput_limit = pool_size ÷ average_query_seconds
```

For this lab's `/products` endpoint (17.5 ms query, pool of 10):

```
10 ÷ 0.0175 = ~570 queries/sec   before anything queues
```

Above that, latency grows without any component failing.

---

## 4. Experiment 2 — hitting the server limit

Opening raw connections one at a time until Postgres refuses:

```
  opened 20 connections...
  opened 40 connections...
  opened 60 connections...
  opened 80 connections...

  ✗ FAILED while opening connection #100
  error: sorry, too many clients already
  code : 53300

  successfully held open: 99 connections
```

**SQLSTATE `53300`** is the one to recognise. The connection is *refused* — this
is not queueing, it is a hard failure. Your app gets an exception.

### Why 99 and not 97?

```sql
max_connections                =  100
superuser_reserved_connections =    3
```

Normally a non-superuser can only take `100 − 3 = 97`, leaving 3 slots so an
admin can still log in to fix things.

But this lab's `lab` user **is a superuser** — the official Postgres image makes
`POSTGRES_USER` a superuser by default:

```sql
SELECT current_user, usesuper FROM pg_user WHERE usename = current_user;
--  lab | t
```

So it was allowed into the reserved slots.

**The lesson:** those 3 reserved slots are your emergency access. If your
application connects as a superuser, it can consume them, and when the database
runs out of connections **you won't be able to log in to fix it.** Applications
should never connect as a superuser — this lab does only because it's a lab.

---

## 5. Two limits, not one

This is the core mental model. There are **two independent ceilings**, and they
fail in completely different ways:

```
   ┌─────────────────────────────────────────────────────────┐
   │  APPLICATION                                            │
   │                                                         │
   │   requests ──► POOL (max=10) ──┐                        │
   │                 │              │                        │
   │            exceeded?           │                        │
   │            → they QUEUE        │  ← LIMIT 1: pool size  │
   │            → latency grows     │     symptom: SLOW      │
   │            → nothing errors    │                        │
   └────────────────────────────────┼────────────────────────┘
                                    │
   ┌────────────────────────────────▼────────────────────────┐
   │  DATABASE                                               │
   │                                                         │
   │   max_connections = 100        ← LIMIT 2: server cap    │
   │   exceeded?                       symptom: ERRORS       │
   │   → connection REFUSED                                  │
   │   → SQLSTATE 53300 / MySQL 1040                         │
   └─────────────────────────────────────────────────────────┘
```

| | Pool exhausted | `max_connections` exceeded |
|---|---|---|
| Symptom | requests get **slow** | requests **fail** |
| Error | none (until timeout) | `53300` / `1040` |
| Where visible | app metrics (`waiting > 0`) | app logs, DB logs |
| Fix | bigger pool, faster queries, more replicas | raise limit, or **fewer/pooled connections** |

**Raising the pool size to fix slowness can convert a latency problem into an
outage** — you push more concurrent connections at a database that has its own
hard cap. The two limits must be sized together.

---

## 6. The multiplication trap

The single most common way teams take down a database.

Your pool is per **process**, not per application:

```
   orders-api  replica 1   pool max 10  ──┐
   orders-api  replica 2   pool max 10  ──┤
   orders-api  replica 3   pool max 10  ──┼──►  Postgres
   orders-worker replica 1 pool max  5  ──┤     max_connections = 100
   orders-worker replica 2 pool max  5  ──┘
                                          
   total possible = 3×10 + 2×5 = 40 connections
```

The real formula:

```
total_connections = Σ (replicas × pool_max)   for every service and job
```

It has to stay **below** `max_connections`, with headroom for admin sessions,
migrations, cron jobs, your `psql`, monitoring exporters, and backups.

This bites during autoscaling. A pool of 20 is fine at 3 replicas (60) and fatal
at 10 replicas (200 > 100). **Scaling up the app takes the database down**,
which is a deeply counterintuitive failure.

In this lab right now:

```
orders-api    PG_POOL_MAX = 10
orders-worker PG_POOL_MAX =  5
                            ──
                            15  out of 100 — plenty of headroom
```

### When you outgrow it: an external pooler

At high replica counts you put a pooler between app and database:

```
  many app replicas ──► PgBouncer ──► Postgres
     (1000s of conns)   (multiplexes)   (100 real conns)
```

- **Postgres**: PgBouncer, pgcat, or RDS Proxy
- **MySQL**: ProxySQL, or RDS Proxy

In `transaction` pooling mode a client only holds a real connection for the
duration of a transaction, so thousands of idle app connections map onto a
handful of real ones.

---

## 7. How to size a pool

**Start smaller than you think.** The common instinct — "make the pool big so
nothing waits" — is usually wrong. A pool larger than the database can
usefully parallelise just moves the queue from your app into the database, where
it causes lock contention and context switching instead.

A widely-used starting point for Postgres:

```
pool_size = (core_count × 2) + effective_spindle_count
```

For a 4-core database server: `(4 × 2) + 1 ≈ 9`. Which is roughly why this lab
uses 10 — and why that number is not arbitrary.

Then check it against your throughput need:

```
required_pool = target_rps × average_query_seconds

  1000 rps × 0.005s  =  5 connections
  1000 rps × 0.050s  = 50 connections   ← slow queries are the real problem
```

Notice the lever: **halving query time halves the connections you need.**
Optimising a query is often cheaper than scaling the database.

Then verify against the multiplication trap:

```
replicas × pool_size + overhead  <  max_connections
```

---

## 8. MySQL specifically

You asked about MySQL limits — here's how they work.

### The default and how to change it

```sql
SHOW VARIABLES LIKE 'max_connections';     -- default: 151
SELECT @@max_connections;
```

**MySQL's default is 151.** (It's 151, not 150, so an admin can always get in
after 150 clients connect.)

Unlike Postgres, MySQL can change it **at runtime, no restart**:

```sql
SET GLOBAL max_connections = 500;
```

Persist it in `my.cnf`:

```ini
[mysqld]
max_connections = 500
```

> Postgres requires a **restart** for `max_connections` — it sizes shared memory
> at startup. This is a real operational difference: MySQL you can rescue live,
> Postgres you cannot.

### The error you'll see

```
ERROR 1040 (HY000): Too many connections
```

That's MySQL's equivalent of Postgres's `53300`. MySQL also reserves **one**
extra slot for a user with `SUPER`/`CONNECTION_ADMIN` privilege — the reason for
the odd 151.

### What actually limits it

Raising `max_connections` isn't free. Each connection costs:

- a **thread** (default stack `thread_stack` = 256 KB)
- per-session buffers, allocated **on demand**, per connection:

| Variable | Default | Notes |
|---|---|---|
| `sort_buffer_size` | 256 KB | allocated per sort |
| `join_buffer_size` | 256 KB | per join without an index |
| `read_buffer_size` | 128 KB | per sequential scan |
| `read_rnd_buffer_size` | 256 KB | |
| `net_buffer_length` | 16 KB | grows to `max_allowed_packet` |

Worst-case memory is roughly:

```
max_connections × (thread_stack + sum of per-session buffers)
```

which is why blindly setting `max_connections = 5000` with large buffers can
OOM the server. **A connection limit is really a memory limit in disguise.**

You're also bounded by the OS:

```sql
SHOW VARIABLES LIKE 'open_files_limit';    -- MySQL needs FDs per connection
```

If `open_files_limit` is too low, MySQL silently caps `max_connections` below
what you configured — always verify with `SHOW VARIABLES` after changing it.

### Other MySQL knobs worth knowing

```sql
-- per-user cap, useful for multi-tenant setups
SHOW VARIABLES LIKE 'max_user_connections';
CREATE USER 'app'@'%' WITH MAX_USER_CONNECTIONS 50;

-- idle connections are reaped after this many seconds (default 28800 = 8h!)
SHOW VARIABLES LIKE 'wait_timeout';
SHOW VARIABLES LIKE 'interactive_timeout';

-- how bad has it been since startup?
SHOW GLOBAL STATUS LIKE 'Max_used_connections';    -- high-water mark
SHOW GLOBAL STATUS LIKE 'Threads_connected';       -- right now
SHOW GLOBAL STATUS LIKE 'Connection_errors_max_connections';  -- rejections
SHOW PROCESSLIST;                                  -- who's connected
```

**`Max_used_connections` is the one to check first.** If it's near
`max_connections`, you've been close to the edge even if you haven't fallen off.

The default `wait_timeout` of **8 hours** is a classic footgun: abandoned
connections sit there consuming slots for most of a day.

### Managed MySQL (RDS/Aurora)

Cloud providers set it from instance memory:

```
max_connections = DBInstanceClassMemory / 12582880
```

So a `db.t3.micro` (1 GB) gets ~85 and a `db.r5.large` (16 GB) gets ~1365.
**Your connection limit scales with instance size** — which means resizing an
instance silently changes it in both directions.

---

## 9. Postgres vs MySQL — why the limits differ

| | Postgres | MySQL |
|---|---|---|
| Model | **process** per connection | **thread** per connection |
| Cost each | ~5–10 MB | ~256 KB–1 MB |
| Default limit | 100 | 151 |
| Change at runtime | ❌ restart required | ✅ `SET GLOBAL` |
| Idle connection cost | high (a whole process) | low |
| Reserved slots | `superuser_reserved_connections` (3) | 1 for `SUPER` |
| Error | `53300 sorry, too many clients already` | `1040 Too many connections` |
| Typical pooler | PgBouncer | ProxySQL |
| Realistic ceiling | low hundreds | low thousands |

**Practical consequence:** idle connections are much more expensive in Postgres.
An app that opens 500 mostly-idle Postgres connections is in trouble; the same
pattern against MySQL is merely wasteful. This is why PgBouncer is near-mandatory
at scale for Postgres and ProxySQL is more of an optimisation for MySQL.

---

## 10. Observing this in the lab

The app exports pool state as
[`db_pool_connections`](../services/orders-api/src/metrics.ts):

```promql
sum by (state) (db_pool_connections)      # in_use / idle / waiting
```

**`waiting > 0` is the smoking gun.** From
[alerts.yml](../observability/prometheus/rules/alerts.yml):

```yaml
- alert: DbPoolSaturated
  expr: sum(db_pool_connections{state="waiting"}) > 0
  for: 2m
  labels: { severity: ticket }
```

The database side, via postgres_exporter:

```promql
sum(pg_stat_activity_count{datname="ordersdb"})    # connections in use
max(pg_settings_max_connections)                   # the ceiling
sum(pg_stat_activity_count) / max(pg_settings_max_connections)   # headroom
```

Directly in SQL:

```bash
docker compose exec -T postgres psql -U lab -d ordersdb -c "
SELECT state, count(*) FROM pg_stat_activity
WHERE backend_type='client backend' GROUP BY state;"

docker compose exec -T postgres psql -U lab -d ordersdb -c "
SELECT setting FROM pg_settings WHERE name='max_connections';"
```

### Reproduce pool saturation yourself

Shrink the pool and drive load:

```yaml
# docker-compose.yml, orders-api
PG_POOL_MAX: 2        # ceiling drops to ~114 q/s on /products
```

```bash
docker compose up -d orders-api
docker compose run --rm k6 run /scripts/05-flush-cache.js
```

Watch `db_pool_connections{state="waiting"}` go above zero on the USE dashboard,
with p99 following it.

### In a trace

Pool waiting has a distinctive shape: **a gap before the database span starts.**

```
POST /checkout                    850ms
  ├── [gap — 780ms]                      ← waiting for a connection
  └── pg.query:INSERT                4ms ← the query itself was fast
```

The query is fast. The *waiting* is not. No database metric will show you that
gap — only the trace.

---

## 11. Diagnosing connection problems

| Symptom | Likely cause | Check |
|---|---|---|
| Latency up, DB idle, CPU flat | **pool exhausted** | `db_pool_connections{state="waiting"} > 0` |
| `53300` / `1040` errors | **server limit hit** | `pg_stat_activity` count vs `max_connections` |
| Errors right after scaling up | **multiplication trap** | `replicas × pool_max` |
| Slow only at peak | pool too small for peak rps | `target_rps × query_seconds` |
| Connections climb and never drop | **leak** — not releasing | pooled clients not `release()`d |
| Fine at first, degrades over hours | idle connections accumulating | `idleTimeoutMillis` / `wait_timeout` |
| Can't log in to fix an incident | reserved slots consumed | app connecting as superuser |

### The connection leak

The most common application bug in this area:

```ts
// ✗ LEAK — if the query throws, the client is never returned
const client = await pool.connect();
const res = await client.query('SELECT ...');
client.release();

// ✓ correct
const client = await pool.connect();
try {
  const res = await client.query('SELECT ...');
} finally {
  client.release();      // runs even on throw
}
```

That's exactly the pattern in
[`routes/orders.ts`](../services/orders-api/src/routes/orders.ts), where a
transaction needs a dedicated client:

```ts
const client = await pool.connect();
try {
  await client.query('BEGIN');
  ...
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
}
```

A leak looks like a slow strangulation: the pool works, then gets slower, then
every request times out — and a restart "fixes" it, which is the tell.

> Note `pool.query()` handles checkout/release for you automatically. You only
> need `pool.connect()` when you need **the same connection** across several
> statements — i.e. transactions.

---

## Summary

1. A connection is a **process** in Postgres, a **thread** in MySQL. That one
   fact drives every other difference.
2. **Two limits**: pool size (exceeded → *slow*) and `max_connections`
   (exceeded → *errors*). Size them together.
3. Pool exhaustion is invisible to the database — it looks idle while your app
   crawls. `waiting > 0` and a gap in the trace are how you see it.
4. `throughput = pool_size ÷ query_time`. **Faster queries need fewer
   connections.**
5. `replicas × pool_max` must stay under `max_connections`. Autoscaling can take
   down a database.
6. MySQL default **151**, changeable live. Postgres default **100**, needs a
   restart.
7. Always `release()` in a `finally`.
8. Never let your application connect as a superuser — those reserved slots are
   how you get back in.

---

Related: [db.ts](../services/orders-api/src/db.ts) ·
[exercise 4 — flushCache](exercises/04-flush-cache.md) ·
[01-first-look.md](01-first-look.md)
