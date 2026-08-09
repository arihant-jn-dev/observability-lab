-- Schema for the orders/checkout domain.
--
-- Files in /docker-entrypoint-initdb.d are executed by the official postgres
-- image ONCE, on first boot of an empty data directory. If you change this file
-- you must `docker compose down -v` to wipe the volume and re-init.

CREATE TABLE customers (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'standard',  -- standard | premium
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          SERIAL PRIMARY KEY,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stock       INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed | shipped
  total_cents  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL,
  price_cents INTEGER NOT NULL
);

-- Deliberately indexed. The N+1 pathology is NOT about missing indexes -- each
-- of its 50 queries is individually fast and index-backed. That is the whole
-- lesson: N+1 is a *round-trip count* problem, not a slow-query problem, which
-- is why it is invisible to "slow query log" style tooling and obvious in a trace.
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_orders_customer_id   ON orders(customer_id);
CREATE INDEX idx_orders_created_at    ON orders(created_at DESC);
CREATE INDEX idx_products_category    ON products(category);

-- pg_stat_statements lets postgres_exporter surface per-query stats later.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
