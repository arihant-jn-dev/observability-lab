-- Seed data.
--
-- Sizes are chosen so the pathologies are *measurable*:
--   500 products      -> a full product list is big enough that caching it matters
--   200 customers     -> enough distinct values to make a cardinality lesson real
--   5000 orders       -> /orders pagination has something to page through
--   ~4 items/order    -> N+1 on a 50-order page = ~50 extra round trips

INSERT INTO customers (email, name, tier)
SELECT
  'customer' || i || '@example.com',
  'Customer ' || i,
  CASE WHEN i % 5 = 0 THEN 'premium' ELSE 'standard' END
FROM generate_series(1, 200) AS i;

INSERT INTO products (sku, name, category, price_cents, stock)
SELECT
  'SKU-' || lpad(i::text, 5, '0'),
  'Product ' || i,
  (ARRAY['electronics','books','clothing','home','toys'])[1 + (i % 5)],
  500 + (i * 37) % 45000,
  10 + (i % 200)
FROM generate_series(1, 500) AS i;

INSERT INTO orders (customer_id, status, total_cents, created_at)
SELECT
  1 + (i % 200),
  (ARRAY['pending','paid','paid','paid','shipped','failed'])[1 + (i % 6)],
  0,
  now() - (i || ' minutes')::interval
FROM generate_series(1, 5000) AS i;

-- 3-5 line items per order.
INSERT INTO order_items (order_id, product_id, quantity, price_cents)
SELECT
  o.id,
  1 + ((o.id * n * 7) % 500),
  1 + (n % 3),
  p.price_cents
FROM orders o
CROSS JOIN generate_series(1, 3 + (random() * 2)::int) AS n
JOIN products p ON p.id = 1 + ((o.id * n * 7) % 500);

-- Make order totals consistent with their items.
UPDATE orders o
SET total_cents = sub.total
FROM (
  SELECT order_id, SUM(quantity * price_cents) AS total
  FROM order_items GROUP BY order_id
) sub
WHERE o.id = sub.order_id;

ANALYZE;
