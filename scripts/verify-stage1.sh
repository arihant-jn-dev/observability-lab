#!/usr/bin/env bash
# Stage 1 end-to-end verification.
#
# Every check asserts on real behaviour of a running stack -- no mocks. If this
# passes, the application layer is sound and you can trust that anything you see
# in later stages is a telemetry problem, not an app problem.
set -uo pipefail

API=http://localhost:8080
PASS=0
FAIL=0

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
head1() { printf "\n\033[1m%s\033[0m\n" "$1"; }

heal() { curl -s -XPOST "$API/admin/pathologies/reset" >/dev/null 2>&1; }
trap heal EXIT

head1 "containers"
for c in obslab-postgres obslab-redis obslab-orders-api obslab-payments-api obslab-orders-worker; do
  status=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  [ "$status" = "running" ] && ok "$c running" || bad "$c is '$status'"
done

head1 "seed data"
counts=$(docker compose exec -T postgres psql -U lab -d ordersdb -tAc \
  "SELECT count(*) FROM products" 2>/dev/null | tr -d '[:space:]')
[ "$counts" = "500" ] && ok "500 products seeded" || bad "expected 500 products, got '$counts'"

head1 "read path + cache"
curl -s -XPOST "$API/admin/cache/flush" >/dev/null
h1=$(curl -s "$API/products?limit=5" | python3 -c 'import sys,json;print(json.load(sys.stdin)["cacheHit"])')
h2=$(curl -s "$API/products?limit=5" | python3 -c 'import sys,json;print(json.load(sys.stdin)["cacheHit"])')
[ "$h1" = "False" ] && ok "first read = cache MISS" || bad "first read should miss, got $h1"
[ "$h2" = "True"  ] && ok "second read = cache HIT" || bad "second read should hit, got $h2"

head1 "write path -> queue -> worker"
oid=$(curl -s -XPOST "$API/orders" -H 'content-type: application/json' \
  -d '{"customerId":5,"items":[{"productId":3,"quantity":1}]}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["orderId"])')
[ -n "$oid" ] && ok "order $oid created (status pending)" || bad "order creation failed"
sleep 3
st=$(docker compose exec -T postgres psql -U lab -d ordersdb -tAc \
  "SELECT status FROM orders WHERE id=$oid" 2>/dev/null | tr -d '[:space:]')
[ "$st" = "shipped" ] && ok "worker consumed job -> status 'shipped'" \
                      || bad "worker did not process order (status='$st')"

head1 "cross-service call (orders-api -> payments-api)"
cs=$(curl -s -XPOST "$API/checkout" -H 'content-type: application/json' \
  -d '{"amountCents":4200}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
[ "$cs" = "paid" ] && ok "checkout approved by payments-api" || bad "checkout status='$cs'"

head1 "pathology: nPlusOne"
q1=$(curl -s "$API/orders?limit=50" | python3 -c 'import sys,json;print(json.load(sys.stdin)["queryCount"])')
curl -s -XPOST "$API/admin/pathologies" -H 'content-type: application/json' \
  -d '{"nPlusOne":{"enabled":true}}' >/dev/null
q2=$(curl -s "$API/orders?limit=50" | python3 -c 'import sys,json;print(json.load(sys.stdin)["queryCount"])')
heal
[ "$q1" = "2" ] && ok "healthy path = 2 queries" || bad "healthy path = $q1 queries"
[ "$q2" = "51" ] && ok "N+1 path = 51 queries" || bad "N+1 path = $q2 queries"

head1 "pathology: slow is route-scoped"
curl -s -XPOST "$API/admin/pathologies" -H 'content-type: application/json' \
  -d '{"slow":{"enabled":true,"ms":700,"route":"/products"}}' >/dev/null
tp=$(curl -s -o /dev/null -w '%{time_total}' "$API/products?limit=5")
to=$(curl -s -o /dev/null -w '%{time_total}' "$API/orders?limit=5")
heal
awk -v t="$tp" 'BEGIN{exit !(t>0.6)}' && ok "/products slowed to ${tp}s" || bad "/products was ${tp}s"
awk -v t="$to" 'BEGIN{exit !(t<0.3)}' && ok "/orders unaffected (${to}s)" || bad "/orders was ${to}s"

head1 "pathology: errorRate (and admin stays reachable)"
curl -s -XPOST "$API/admin/pathologies" -H 'content-type: application/json' \
  -d '{"errorRate":{"enabled":true,"pct":100}}' >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/products?limit=2")
admin=$(curl -s -o /dev/null -w '%{http_code}' "$API/admin/pathologies")
heal
[ "$code" = "500" ]  && ok "requests fail at 100% error rate" || bad "got $code, expected 500"
[ "$admin" = "200" ] && ok "/admin still reachable (exemption works)" || bad "/admin returned $admin"

head1 "pathology: memLeak modes"
curl -s -XPOST "$API/admin/pathologies" -H 'content-type: application/json' \
  -d '{"memLeak":{"enabled":true,"kbPerRequest":4096,"mode":"buffer"}}' >/dev/null
for i in $(seq 1 20); do curl -s -o /dev/null "$API/products?limit=2"; done
read -r rss heap <<<"$(curl -s "$API/admin/pathologies" \
  | python3 -c 'import sys,json;m=json.load(sys.stdin)["memory"];print(m["rssMb"],m["heapUsedMb"])')"
heal; curl -s -XPOST "$API/admin/memory/release" >/dev/null
awk -v r="$rss" 'BEGIN{exit !(r>180)}' && ok "off-heap leak grew RSS to ${rss}MB" || bad "RSS only ${rss}MB"
awk -v h="$heap" 'BEGIN{exit !(h<80)}' \
  && ok "heap stayed flat at ${heap}MB -- heap metrics MISS this leak" \
  || bad "heap was ${heap}MB (expected flat)"

printf "\n\033[1m%d passed, %d failed\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
