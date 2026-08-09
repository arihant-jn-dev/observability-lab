# Fastify — the web framework

Fastify is a web framework for Node.js, similar to Express.js. It helps you
build HTTP APIs and web servers.

In this project it sits right at the front door:

```
k6
 │
 │ HTTP request
 ▼
┌─────────────────────┐
│     Fastify         │
│    Node.js app      │
│                     │
│  GET  /orders       │
│  POST /orders       │
│  GET  /health       │
└─────────┬───────────┘
          │
     ┌────┼─────┐
     ▼    ▼     ▼
   Redis  DB   payments-api
```

Two services here use it: **orders-api** (`:8080`) and **payments-api**
(`:8081`).

---

## What does Fastify actually do?

Suppose you write:

```ts
import Fastify from "fastify";

const app = Fastify();

app.get("/hello", async () => {
  return {
    message: "Hello World"
  };
});

app.listen({ port: 8080 });
```

Fastify creates an HTTP server.

When someone sends:

```
GET http://localhost:8080/hello
```

Fastify receives the request:

```
Browser / k6
      │
      │ GET /hello
      ▼
   Fastify
      │
      ▼
 route handler
      │
      ▼
{ message: "Hello World" }
```

The response becomes:

```json
{
  "message": "Hello World"
}
```

Notice you never wrote JSON serialisation, status codes, or content-type
headers. **Return an object, and Fastify sends JSON with `200 OK`.** That is
most of what a web framework is for.

---

## How it's set up in this project

The server is built in one function,
[`src/server.ts`](../services/orders-api/src/server.ts):

```ts
export function buildServer() {
  const app = Fastify({
    loggerInstance: logger,          // our Pino logger, with the trace mixin
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
  });

  app.addHook('onRequest', ...);     // the pathology hook
  app.setErrorHandler(...);          // catch-all error handling

  app.register(healthRoutes);
  app.register(adminRoutes);
  app.register(productRoutes);
  app.register(orderRoutes);
  app.register(checkoutRoutes);

  return app;
}
```

Then [`src/index.ts`](../services/orders-api/src/index.ts) starts it:

```ts
const app = buildServer();
await app.listen({ port: config.port, host: config.host });
```

`host: '0.0.0.0'` matters in Docker — the default `localhost` would only accept
connections from *inside* the container, and your `curl` from the Mac would
fail.

---

## Routes are grouped into plugins

Rather than one giant file, each group of endpoints is a function:

```
server.ts
   │
   ├── register ──► routes/health.ts    GET  /health, /ready
   ├── register ──► routes/admin.ts     GET/POST /admin/*
   ├── register ──► routes/products.ts  GET  /products, /products/:id
   ├── register ──► routes/orders.ts    GET/POST /orders
   └── register ──► routes/checkout.ts  POST /checkout
```

Each one is just a function that receives `app`:

```ts
export async function productRoutes(app: FastifyInstance) {
  app.get('/products', async (req) => { ... });
  app.get('/products/:id', async (req, reply) => { ... });
}
```

`app.register()` loads it. This is Fastify's **plugin system** — the same
mechanism third-party packages like `@fastify/otel` use to hook in.

---

## Reading input: params, query, body

Fastify gives you three places data arrives, and TypeScript generics describe
each. From [`routes/products.ts`](../services/orders-api/src/routes/products.ts):

```ts
// QUERY STRING  ->  /products?category=books&limit=20
app.get<{ Querystring: { category?: string; limit?: string } }>(
  '/products',
  async (req) => {
    const category = req.query.category ?? 'all';
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
  }
);

// URL PARAMS  ->  /products/42
app.get<{ Params: { id: string } }>('/products/:id', async (req, reply) => {
  const id = Number(req.params.id);
});

// JSON BODY  ->  POST /checkout {"amountCents": 4200}
app.post<{ Body: { customerId?: number; amountCents?: number } }>(
  '/checkout',
  async (req, reply) => {
    const amountCents = req.body?.amountCents ?? 1000;
  }
);
```

```
Request
   │
   ├── req.params   ─► from the URL path   /products/:id
   ├── req.query    ─► after the ?         ?limit=20
   ├── req.body     ─► JSON payload        {"amountCents":4200}
   └── req.headers  ─► HTTP headers        x-simulate-delay-ms
```

Fastify parses the JSON body for you. Note the generics are **types only** —
they help your editor, they do not validate at runtime.

---

## Sending output: return vs reply

Two ways, and the difference matters:

```ts
// 1. Just return it -> 200 OK + JSON
app.get('/health', async () => ({ status: 'ok' }));

// 2. Control the status code -> use reply
app.get('/products/:id', async (req, reply) => {
  if (!value) return reply.code(404).send({ error: 'product not found' });
  return { product: value };
});
```

Real examples from this project:

```ts
return reply.code(201).send({ orderId, totalCents: total, status: 'pending' });
return reply.code(402).send({ orderId, status: 'failed' });   // payment declined
return reply.code(400).send({ error: 'bad id' });
```

---

## The request lifecycle — where hooks fit

This is the most useful Fastify concept for this project. Every request passes
through a series of stages, and you can attach code to any of them:

```
        incoming request
               │
               ▼
        ┌──────────────┐
        │  onRequest   │  ◄── THE PATHOLOGY HOOK LIVES HERE
        └──────┬───────┘      (errorRate, cpuBurn, memLeak, slow)
               │
               ▼
        ┌──────────────┐
        │ preValidation│
        └──────┬───────┘
               │
               ▼
        ┌──────────────┐
        │   handler    │  ◄── your route function
        └──────┬───────┘      (talks to Redis / Postgres / payments-api)
               │
               ▼
        ┌──────────────┐
        │  onError?    │  ◄── setErrorHandler, if something threw
        └──────┬───────┘
               │
               ▼
           response
```

### The pathology hook

Every failure mode in this lab is injected in **one** `onRequest` hook, before
any route code runs:

```ts
app.addHook('onRequest', async (req, reply) => {
  // /admin and /health are EXEMPT -- otherwise errorRate:100 would break
  // the endpoint you need to switch it back off
  if (url.startsWith('/admin') || url.startsWith('/health')) return;

  if (p.errorRate.enabled && shouldFail(p.errorRate.pct)) {
    return reply.code(500).send({ error: 'injected failure' });   // stops here
  }
  if (p.cpuBurn.enabled) burnCpu(p.cpuBurn.ms);
  if (p.memLeak.enabled) leakMemory(p.memLeak.kbPerRequest, p.memLeak.mode);
  if (p.slow.enabled && url.startsWith(p.slow.route)) await sleep(p.slow.ms);
});
```

**Calling `reply.send()` inside a hook short-circuits the request** — the handler
never runs. That's how `errorRate` fails a request before it does any work.

This is why hooks are useful: one place, applied to every route, without
touching a single handler.

### The error handler

```ts
app.setErrorHandler((err, req, reply) => {
  span?.recordException(err);                    // mark the trace red in Tempo
  span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  req.log.error({ err, url: req.url }, 'request failed');   // log with trace_id
  reply.code(err.statusCode ?? 500).send({ error: err.message });
});
```

Any `throw` anywhere in any handler lands here. One place that guarantees every
failure is logged *and* marked on the trace.

---

## Logging: `req.log`

Because we pass our Pino instance in as `loggerInstance`, Fastify gives every
request its own logger:

```ts
req.log.error({ pathology: 'errorRate' }, 'injected failure');
```

That line automatically carries `trace_id`, because
[`logger.ts`](../services/orders-api/src/logger.ts) has a mixin that reads the
active span. So a log written inside a Fastify handler is correlated to the
trace for free.

Fastify also logs every request/response itself (`disableRequestLogging: false`)
— that's where the `incoming request` / `request completed` lines in Loki come
from.

---

## Fastify and OpenTelemetry

One Fastify-specific gotcha that matters a lot here.

`@fastify/otel` is registered in
[`otel.ts`](../services/orders-api/src/otel.ts):

```ts
new FastifyOtelInstrumentation({ registerOnInitialization: true })
```

**Without it**, you still get HTTP spans — but named `GET`, with no
`http.route` attribute:

```
with @fastify/otel      without it
──────────────────      ──────────
POST /checkout          POST
GET  /products          GET
GET  /orders/:id        GET
```

`http.route` is the *route template* (`/products/:id`), not the raw URL
(`/products/42`). That distinction is what keeps metric cardinality bounded —
one series per route instead of one per product id — and it's what every panel
on the RED dashboard groups by.

It also adds handler-level spans, so a trace shows time inside the hook vs
inside the handler:

```
POST /checkout                       2039ms
  ├── onRequest - checkoutRoutes        0.1ms
  ├── handler - checkoutRoutes       2038ms
  │     ├── pg.query:INSERT              4.9ms
  │     └── POST → payments-api       2006ms
```

> Note: `@opentelemetry/instrumentation-fastify` is **deprecated**.
> `@fastify/otel`, maintained by the Fastify team, is the replacement.

---

## Why Fastify rather than Express?

| | |
|---|---|
| **Speed** | Faster JSON serialisation and routing |
| **Async/await native** | `async` handlers just work; no `next()` juggling |
| **Schema support** | Can validate and serialise from JSON Schema |
| **TypeScript** | First-class generics for params/query/body |
| **Plugin encapsulation** | Plugins get their own scope, not one global chain |

For this lab the practical wins are **async handlers** (every route awaits
Postgres or Redis) and **hooks**, which let all seven pathologies live in one
place.

---

## Summary

```
       REQUEST
          │
          ▼
   ┌─────────────┐
   │   Fastify   │
   └──────┬──────┘
          │
     onRequest hook      ← pathologies injected here
          │
     route handler       ← your business logic
          │
     ┌────┼────┐
     ▼    ▼    ▼
  Redis  DB  payments-api
          │
          ▼
   reply.code().send()
          │
          ▼
       RESPONSE
```

| Concept | Where in this project |
|---|---|
| Create the server | `buildServer()` in [server.ts](../services/orders-api/src/server.ts) |
| Start listening | `app.listen()` in [index.ts](../services/orders-api/src/index.ts) |
| Group routes | `app.register()` → [routes/](../services/orders-api/src/routes/) |
| Read input | `req.params` · `req.query` · `req.body` · `req.headers` |
| Send output | `return obj` or `reply.code(n).send(obj)` |
| Run code on every request | `app.addHook('onRequest', ...)` |
| Handle all errors | `app.setErrorHandler(...)` |
| Log with trace correlation | `req.log` |
| Get `http.route` on spans | `@fastify/otel` |

---

Related: [07-api-reference.md](07-api-reference.md) — every endpoint with curl ·
[00-how-this-was-built.md](00-how-this-was-built.md)
