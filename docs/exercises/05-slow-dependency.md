# Exercise 5 — `slowDependency`: your latency, someone else's fault

**Run**

```bash
docker compose run --rm k6 run /scripts/06-slow-dependency.js
```

60 s healthy → 180 s with `payments-api` at 5 s → heal.

---

## Do this first: compare it with exercise 1

Run [exercise 1 (`slow`)](01-slow.md), screenshot the RED dashboard, then run
this one and compare.

**The latency graphs look the same.** p99 on one route goes through the roof in
both cases. From metrics alone, these two incidents are indistinguishable.

They have nothing in common as problems, and nothing in common as fixes.

---

## The trace tells them apart instantly

Click an exemplar on the `/checkout` p99 line.

Measured on this stack, a real trace from this exercise:

```
SERVICE        SPAN                                DUR(ms)
orders-api     POST /checkout                       2039.7  ████████████████
orders-api     pg.query:INSERT ordersdb                4.9  █
orders-api     POST                                 2006.9  ████████████████
payments-api     POST /authorize                    2002.9  ████████████████   ← HERE
orders-api     pg.query:UPDATE ordersdb                3.5  █
orders-api     lpush                                   0.6  █
orders-api     process order job                      48.1  █
```

**2002.9 ms of the 2039.7 ms total is inside `payments-api`.** Not inferred —
read directly off the waterfall, with the service name attached.

| Exercise | Trace shape | Responsible |
|---|---|---|
| [1 — `slow`](01-slow.md) | long span, **no slow children** | your code |
| **5 — this one** | long **child span in another service** | the dependency |

Note the delay genuinely happens in the other process. `orders-api` sends an
`x-simulate-delay-ms` header and `payments-api` sleeps — we did not fake it
locally, precisely so the trace assigns blame correctly.

---

## Client-side vs server-side: the refinement

**USE dashboard → "Outbound call latency"** plots two lines deliberately:

- **client-side** — what `orders-api` waited
- **server-side** — what `payments-api` actually spent

In this exercise they move **together**, which means the dependency really is
slow.

If the client line rose while the server line stayed flat, the time would be
going into the network, DNS, TLS, or *your own* connection pool — and their
service would be innocent. Teams lose days to this, escalating to another team
whose dashboards look perfect, because they only ever had one side of the
measurement.

**Instrument both sides of every dependency call.** It is the difference between
"they're slow" and "we can prove where the time goes".

---

## The second-order lesson: blast radius

Watch **`/products`** during this exercise — an endpoint that never calls
`payments-api`.

**It degrades too.** Slow `/checkout` requests occupy VUs, sockets, and event-loop
turns; those are shared resources. A slow dependency on *one* route consumes
capacity that every other route needs.

This is the argument for **timeouts and bulkheads**. Try it:

```yaml
# docker-compose.yml, orders-api
PAYMENTS_TIMEOUT_MS: 1000
```

```bash
docker compose up -d orders-api
docker compose run --rm k6 run /scripts/06-slow-dependency.js
```

Now `/checkout` fails fast at 1 s instead of hanging for 5 s. You have **traded
some failed checkouts for a service that stays up**. That trade is a product
decision, not a technical one — but you cannot even have the conversation
without the data to show what the alternative costs.

---

## Takeaway

1. **Metrics say "slow". Only traces say "whose".**
2. **Instrument both sides** of every dependency call — client and server.
3. **A slow dependency is not contained to the route that calls it.** Shared
   resources spread the damage; timeouts are how you contain it.

**Heal:** `make heal`
