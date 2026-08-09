# Connection pooling and scaling

This topic is very important for backend/system design, especially when you're
working with Node/NestJS, Prisma, MySQL/Postgres, Docker, and Kubernetes.

The easiest way to understand it is:

> Your application does not usually open one database connection per request.
> It maintains a **pool** of reusable database connections.

And there are two different limits you need to think about:

1. **Application/pool limit** — how many connections one application instance is
   allowed to use.
2. **Database-server limit** — how many total connections the database server
   allows.

**Contents**

1. [What a connection actually is](#1-what-a-connection-actually-is)
2. [Why we pool](#2-why-we-pool)
3. [Experiment 1 — pool queueing](#3-experiment-1--pool-queueing)
4. [What happens when the pool is completely busy?](#4-what-happens-when-the-pool-is-completely-busy)
5. [Experiment 2 — hitting the server limit](#5-experiment-2--hitting-the-server-limit)
6. [Two limits, not one](#6-two-limits-not-one)
7. [The multiplication trap](#7-the-multiplication-trap)
8. [A real-world example](#8-a-real-world-example)
9. [How to size a pool](#9-how-to-size-a-pool)
10. [More connections ≠ more performance](#10-more-connections--more-performance)
11. [MySQL specifically](#11-mysql-specifically)
12. [What happens when MySQL reaches its limit?](#12-what-happens-when-mysql-reaches-its-limit)
13. [Postgres vs MySQL — why the limits differ](#13-postgres-vs-mysql--why-the-limits-differ)
14. [PostgreSQL has another important concept](#14-postgresql-has-another-important-concept)
15. [Why connection pools are especially important with Postgres](#15-why-connection-pools-are-especially-important-with-postgres)
16. [What does "pool queueing" look like in your application?](#16-what-does-pool-queueing-look-like-in-your-application)
17. [Connection pool and p95/p99](#17-connection-pool-and-p95p99)
18. [Diagnosing connection problems](#18-diagnosing-connection-problems)
19. [The mental model I'd recommend](#19-the-mental-model-id-recommend)
20. [The key formula](#20-the-key-formula)
21. [The biggest takeaway](#the-biggest-takeaway)

---

## 1. What a connection actually is

Suppose your NestJS application needs to run:

```sql
SELECT * FROM users WHERE id = 10;
```

Your application needs a communication channel to the database.

Conceptually:

```
Node.js application
       |
       | TCP connection
       |
       v
     MySQL
```

A database connection is not just a simple variable. It involves things like:

- TCP connection
- authentication
- database session
- buffers/state
- server-side resources
- client-side resources

So opening a new connection for every HTTP request would be expensive.

For example:

```
Request 1 → open DB connection → query → close
Request 2 → open DB connection → query → close
Request 3 → open DB connection → query → close
...
```

That's inefficient. Instead, we use a **connection pool**.

---

## 2. Why we pool

A connection pool keeps connections open and reuses them.

Instead of:

```
Request
   ↓
Create connection
   ↓
Query
   ↓
Destroy connection
```

we do:

```
                    ┌── Connection 1 ──┐
                    ├── Connection 2 ──┤
Application → Pool ─├── Connection 3 ──┤→ Database
                    ├── Connection 4 ──┤
                    └── Connection 5 ──┘
```

Suppose your pool has `max connections = 5`. You can have at most 5 database
operations actively using a connection at a time.

Imagine 10 requests arrive:

```
Request 1 ──→ Connection 1
Request 2 ──→ Connection 2
Request 3 ──→ Connection 3
Request 4 ──→ Connection 4
Request 5 ──→ Connection 5

Request 6 ──→ WAIT
Request 7 ──→ WAIT
Request 8 ──→ WAIT
Request 9 ──→ WAIT
Request 10 ─→ WAIT
```

When request 1 finishes, Connection 1 becomes free:

```
Request 6 → Connection 1
```

This is called **pool queueing**.

---

## 3. Experiment 1 — pool queueing

Imagine `Pool size = 3` and you have **10 requests** arriving simultaneously.

Only 3 can use the DB at once:

```
             CONNECTION POOL
          ┌───────────────────┐
Request 1 → Connection 1      │
Request 2 → Connection 2      │
Request 3 → Connection 3      │
Request 4 → WAITING           │
Request 5 → WAITING           │
Request 6 → WAITING           │
Request 7 → WAITING           │
Request 8 → WAITING           │
Request 9 → WAITING           │
Request10 → WAITING           │
          └───────────────────┘
```

This doesn't necessarily mean there is an error. The requests can simply wait.

For example:

```
Request 1: 100 ms
Request 2: 100 ms
Request 3: 100 ms
```

After 100 ms:

```
Request 4 → Connection 1
Request 5 → Connection 2
Request 6 → Connection 3
```

So the pool acts like a **traffic controller**.

---

## 4. What happens when the pool is completely busy?

This is where things become interesting.

Suppose `Pool size = 5` and all five connections are busy:

```
Connection 1 → busy
Connection 2 → busy
Connection 3 → busy
Connection 4 → busy
Connection 5 → busy
```

A new request arrives. It can't immediately get a connection, so it waits:

```
Request
   ↓
Connection pool
   ↓
All 5 busy
   ↓
WAIT
```

But it cannot wait forever. Most database clients have a **connection
acquisition timeout**.

For example:

```
Wait 10 seconds
        ↓
Connection still unavailable
        ↓
Throw timeout error
```

You might see errors such as:

```
Timed out fetching a new connection from the connection pool
```

The exact message depends on the driver/ORM. For Prisma, for example, you may
see errors related to connection pool timeout.

The important distinction is:

> **Pool exhaustion is different from database-server connection exhaustion.**

---

## 5. Experiment 2 — hitting the server limit

Now suppose your database says `Maximum connections = 100` and your application
pool says `Pool max = 20`.

One application instance can therefore use up to **20 connections**. That's fine.

But suppose you have 6 application instances:

```
Instance 1 → 20
Instance 2 → 20
Instance 3 → 20
Instance 4 → 20
Instance 5 → 20
Instance 6 → 20
```

Potential maximum:

```
6 × 20 = 120
```

But database allows only:

```
100
```

Now you have a problem.

---

## 6. Two limits, not one

This is probably the most important concept. There are two separate limits.

**Limit 1 — Application pool**

For example `Pool max = 20`. This means: *this application instance* can use at
most 20 DB connections.

**Limit 2 — Database server**

For example `MySQL max_connections = 100`. This means: MySQL will accept at most
approximately 100 simultaneous client connections.

So:

```
Application
     |
     | pool max = 20
     ↓
Connection Pool
     |
     | up to 20
     ↓
MySQL
     |
     | max_connections = 100
     ↓
```

These are **independent limits**.

---

## 7. The multiplication trap

This is where Kubernetes makes things especially important.

Suppose `DB max connections = 100` and your application has `pool max = 20`.

You might think:

> "My application only uses 20 connections, so I'm safe."

Not necessarily. Because you might have:

```
Pod 1 → 20
Pod 2 → 20
Pod 3 → 20
Pod 4 → 20
Pod 5 → 20
```

Total:

```
20 × 5 = 100
```

You have already consumed the entire database connection capacity.

Now imagine Kubernetes scales to **10 pods**:

```
10 × 20 = 200
```

But `DB max = 100`. Now half your pods may fail to acquire connections.

This is called the **connection pool multiplication problem**.

---

## 8. A real-world example

Suppose you have:

```
Kubernetes
│
├── API Pod 1 → pool max 10
├── API Pod 2 → pool max 10
├── API Pod 3 → pool max 10
├── API Pod 4 → pool max 10
└── API Pod 5 → pool max 10
```

Potential connections:

```
5 × 10 = 50
```

Your database: `max_connections = 100`. You're okay.

Now autoscaling happens — **20 pods**:

```
20 × 10 = 200
```

Database: `100`.

🚨 Problem.

That's why **pool size cannot be considered independently from deployment
scale**.

---

## 9. How to size a pool

A simple starting calculation is:

```
Total possible DB connections
    =
number of application instances
×
pool size
```

For example:

```
10 pods
×
8 connections
=
80 connections
```

But you should not necessarily use all 100 DB connections.

Suppose `DB max = 100`. You might reserve some capacity for:

- admin connections
- migrations
- monitoring
- background workers
- other services
- operational/debugging access

So maybe `Available for API = 80`. Then:

```
80 / 10 pods
=
8 connections per pod
```

So `pool max ≈ 8`.

This isn't a universal formula, but it's a useful starting point.

---

## 10. More connections ≠ more performance

This is another very important misconception.

You might think:

```
pool = 10
   ↓ increase
pool = 100
   ↓ therefore
application becomes 10× faster
```

**No.**

The database itself has limited resources:

- CPU
- RAM
- Disk I/O
- Locks
- Query execution capacity
- Network

If you send too many simultaneous queries:

```
100 connections
      ↓
100 queries simultaneously
      ↓
Database overloaded
      ↓
Queries become slower
      ↓
Connections stay busy longer
      ↓
Pool becomes exhausted
      ↓
Requests start timing out
```

You can actually make the application **slower** by increasing the pool too much.

---

## 11. MySQL specifically

MySQL has a server-side setting: `max_connections`

You can check it with:

```sql
SHOW VARIABLES LIKE 'max_connections';
```

For example `max_connections = 151` means MySQL is configured to allow around
151 simultaneous client connections.

You can also inspect current connections:

```sql
SHOW STATUS LIKE 'Threads_connected';
```

For example `Threads_connected = 47` means roughly 47 client connections are
currently connected.

You can also look at:

```sql
SHOW STATUS LIKE 'Max_used_connections';
```

This tells you the highest number of simultaneous connections observed since the
server status was reset.

---

## 12. What happens when MySQL reaches its limit?

Suppose `max_connections = 100` and MySQL already has 100 connections.

Another client tries to connect. MySQL can reject it with an error along the
lines of:

```
Too many connections
```

This is **not** the same thing as pool exhaustion.

The sequence is:

```
Application
    ↓
Pool wants a new connection
    ↓
MySQL
    ↓
MySQL says:
"Too many connections"
```

The application/ORM may then expose its own higher-level error.

---

## 13. Postgres vs MySQL — why the limits differ

This is an important question because you'll often see different
default/configured connection limits.

PostgreSQL has `max_connections`. MySQL has `max_connections`. So the basic
concept is actually similar.

But Postgres and MySQL have different architectures, memory characteristics,
defaults, connection handling, and deployment patterns, so you shouldn't assume
that the same number of connections is appropriate for both.

One major consideration is that **PostgreSQL traditionally uses a process-based
architecture** where a client connection is associated with a backend server
process.

Conceptually:

```
PostgreSQL

Client 1 → Backend process 1
Client 2 → Backend process 2
Client 3 → Backend process 3
...
```

Those processes consume memory and other resources.

**MySQL's server architecture is different**; connection handling is generally
more thread-oriented in common MySQL configurations.

Conceptually:

```
MySQL

Client 1 → server thread
Client 2 → server thread
Client 3 → server thread
...
```

So the resource cost and behavior aren't identical.

That's one reason you shouldn't say:

> "Postgres supports X connections, therefore MySQL should also use X."

Instead, you need to consider:

```
DB engine
+
hardware
+
query workload
+
connection memory usage
+
pool configuration
+
number of application instances
```

---

## 14. PostgreSQL has another important concept

Postgres often has a configured `max_connections`.

But **not every connection is necessarily available to normal application
users.** There can be reserved connection capacity for superusers/emergency
access.

You'll commonly see configuration concepts such as:

```
max_connections
superuser_reserved_connections
```

So if `max_connections = 100`, you shouldn't blindly think:

> "My application can always consume all 100."

Some capacity may be reserved.

---

## 15. Why connection pools are especially important with Postgres

Imagine:

```
Postgres
max_connections = 100
```

You have **20 Kubernetes pods**. If every pod has `pool = 20`, then:

```
20 × 20 = 400
```

Potential connections. That's obviously far beyond `100`.

A common architecture is therefore:

```
                 ┌── API Pod → small pool
                 ├── API Pod → small pool
Users → LB ──────┼── API Pod → small pool
                 ├── API Pod → small pool
                 └── API Pod → small pool
                         │
                         ↓
                   PostgreSQL
```

And for larger systems, a connection pooler such as **PgBouncer** may sit
between applications and PostgreSQL:

```
Applications
     │
     │ many client connections
     ↓
  PgBouncer
     │
     │ fewer DB connections
     ↓
 PostgreSQL
```

That allows many application clients to share a smaller number of actual
PostgreSQL connections.

---

## 16. What does "pool queueing" look like in your application?

Let's say `pool max = 5`.

You receive **100 requests/sec**, but each query takes **200 ms**.

At a very simplified level, each connection can complete about:

```
1 / 0.2 = 5 requests/sec
```

Five connections:

```
5 × 5 = ~25 requests/sec
```

So if you're receiving 100 requests/sec but the DB work requires those
connections for ~200 ms, you'll build a queue.

This connects directly to the throughput and latency concepts you've been asking
about.

---

## 17. Connection pool and p95/p99

Suppose everything normally looks like:

```
p50 = 50 ms
p95 = 100 ms
p99 = 150 ms
```

Then traffic increases. Pool becomes saturated:

```
Request
   ↓
Wait for DB connection
   ↓
Execute query
```

Now the latency might become:

```
p50 = 80 ms
p95 = 500 ms
p99 = 2 sec
```

The database query itself might still take only **100 ms**.

The additional latency is **waiting for a connection**.

That's why monitoring **pool wait time** is extremely useful.

---

## 18. Diagnosing connection problems

When you see an error like `Connection timeout`, don't immediately assume:

> "Database is down."

There are several possibilities.

### Case 1 — Pool is too small

```
Pool = 5

All 5 busy
↓
Requests wait
↓
Timeout
```

Database may actually be perfectly healthy.

### Case 2 — Queries are too slow

```
Pool = 10

10 queries running
↓
Each query takes 30 seconds
↓
Connections remain occupied
↓
New requests wait
```

The real problem might be **slow SQL** rather than pool size.

### Case 3 — Too many application instances

```
20 pods
×
10 connections
=
200
```

while `DB max = 100`. Now the database can't accept all the connections.

### Case 4 — Connection leak

Suppose your application opens connections but doesn't properly release them.

You can get:

```
Connection 1 → stuck
Connection 2 → stuck
Connection 3 → stuck
...
```

Eventually: **pool exhausted**.

### Case 5 — Database itself is overloaded

You may have 100 connections, but the database CPU is at 100%. Queries become
slow. Then connections remain occupied longer.

Eventually:

```
slow queries
    ↓
connections stay busy
    ↓
pool fills
    ↓
requests wait
    ↓
timeouts
```

So connection exhaustion can sometimes be a **symptom** rather than the root
cause.

---

## 19. The mental model I'd recommend

Think about the system as three layers:

```
                 HTTP REQUESTS
                       │
                       ▼
              ┌─────────────────┐
              │ Application Pod │
              │                 │
              │ Connection Pool │
              │                 │
              │ max = 10        │
              └────────┬────────┘
                       │
                  max 10 connections
                       │
                       ▼
              ┌─────────────────┐
              │    DATABASE     │
              │                 │
              │ max = 100       │
              └─────────────────┘
```

Now add Kubernetes:

```
                Load Balancer
                      │
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
     Pod 1          Pod 2          Pod 3
     pool=10        pool=10        pool=10
       │              │              │
       └──────────────┼──────────────┘
                      ↓
                   Database
                  max = 100
```

Maximum potential connections = **Pods × pool size**

So:

```
3 × 10 = 30
```

If Kubernetes scales to 10:

```
10 × 10 = 100
```

If it scales to 20:

```
20 × 10 = 200  ← problem
```

---

## 20. The key formula

For a normal application architecture, keep this formula in your head:

```
Total potential DB connections
=
number of application instances
×
connections per instance
```

Then compare it against **database max connections**.

For example:

```
DB max     = 200
API pods   = 10
Pool / pod = 15

Potential connections = 10 × 15 = 150
```

So you have:

```
200 - 150 = 50
```

connections of theoretical remaining capacity.

But remember that other services/workers/admin connections also consume that
capacity.

---

## The biggest takeaway

There are really three different situations:

| Situation | What's happening? | Typical symptom |
|---|---|---|
| **Pool available** | Request gets connection immediately | Normal latency |
| **Pool exhausted** | DB connections exist, but your app's pool is busy | Pool acquisition timeout / increased latency |
| **DB limit exhausted** | DB refuses new connections | Too many connections / connection failure |

And the most important scaling equation is:

```
                 pool size
                     ×
              number of pods
                     ↓
        potential DB connections
                     ↓
            must fit within
                     ↓
        database connection budget
```

This is why **"my pool is only 10" doesn't mean you are using only 10
connections** in a Kubernetes environment. If you have 30 pods, your potential
maximum is 300 connections.

If you're using **Prisma + NestJS + MySQL** in your current setup, this becomes
especially concrete because Prisma's connection pool is **per application
process**, so Kubernetes replicas multiply that pool.
