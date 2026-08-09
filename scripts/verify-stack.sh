#!/usr/bin/env bash
# Verifies the OBSERVABILITY PIPELINE end to end: that telemetry actually
# arrives, and that the three signals are genuinely correlated.
#
# Run after `make verify` (which checks the app itself). If the app is sound and
# this passes, anything odd you see later is a real finding, not a broken lab.
set -uo pipefail

PASS=0; FAIL=0
ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
h()   { printf "\n\033[1m%s\033[0m\n" "$1"; }

promq() {
  curl -s 'http://localhost:9090/api/v1/query' --data-urlencode "query=$1" \
    | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']['result']))" 2>/dev/null || echo 0
}

h "generating traffic"
for i in $(seq 1 25); do
  curl -s -o /dev/null "http://localhost:8080/products?limit=10"
  curl -s -o /dev/null "http://localhost:8080/orders?limit=10"
  curl -s -o /dev/null -XPOST http://localhost:8080/checkout \
    -H 'content-type: application/json' -d '{}'
done
echo "  75 requests sent; waiting for export + scrape (~20s)"
sleep 22

h "containers"
EXPECTED="postgres redis orders-api orders-worker payments-api otel-collector prometheus tempo loki alloy grafana cadvisor node-exporter postgres-exporter redis-exporter"
for s in $EXPECTED; do
  st=$(docker inspect -f '{{.State.Status}}' "obslab-$s" 2>/dev/null || echo missing)
  [ "$st" = "running" ] && ok "obslab-$s" || bad "obslab-$s is '$st'"
done

h "stage 2 — metrics reach Prometheus"
[ "$(promq 'sum(rate(http_server_request_duration_seconds_count[2m]))')" -gt 0 ] \
  && ok "HTTP metrics (auto-instrumented)" || bad "no HTTP metrics"
[ "$(promq 'sum(orders_created_total)')" -gt 0 ] \
  && ok "business metrics (hand-written)" || bad "no orders_created_total"
[ "$(promq 'http_server_request_duration_seconds_count{http_route="/checkout"}')" -gt 0 ] \
  && ok "http_route label present (fastify instrumentation)" \
  || bad "http_route MISSING -- @fastify/otel not active"
[ "$(promq 'nodejs_eventloop_delay_p99_seconds')" -gt 0 ] \
  && ok "Node runtime metrics (event loop)" || bad "no runtime metrics"

h "stage 3 — traces reach Tempo"
TR=$(curl -s "http://localhost:3210/api/search?limit=10&start=$(($(date +%s)-400))&end=$(date +%s)" \
     | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('traces',[])))" 2>/dev/null || echo 0)
[ "$TR" -gt 0 ] && ok "$TR traces queryable in Tempo" || bad "no traces in Tempo"

# Use TraceQL rather than plain search: plain /api/search returns whatever is
# most recent, which under load is dominated by one endpoint. TraceQL asks for
# the trace we actually want.
TID=$(curl -s -G "http://localhost:3210/api/search" \
      --data-urlencode 'q={name="POST /checkout"}' \
      --data-urlencode "start=$(($(date +%s)-400))" \
      --data-urlencode "end=$(date +%s)" --data-urlencode 'limit=5' \
      | python3 -c "
import sys,json
t=json.load(sys.stdin).get('traces',[])
print(t[0]['traceID'] if t else '')" 2>/dev/null)
if [ -n "$TID" ]; then
  SVCS=$(curl -s "http://localhost:3210/api/traces/$TID" | python3 -c "
import sys,json
s=set()
for b in json.load(sys.stdin).get('batches',[]):
    for a in b.get('resource',{}).get('attributes',[]):
        if a['key']=='service.name': s.add(a['value']['stringValue'])
print(len(s))" 2>/dev/null || echo 0)
  [ "$SVCS" -ge 2 ] && ok "trace spans $SVCS services (cross-service propagation)" \
                    || bad "trace only covers $SVCS service"
else
  bad "no /checkout trace found"
fi

h "stage 3 — exemplars link metrics to traces"
EX=$(curl -s 'http://localhost:9090/api/v1/query_exemplars' \
  --data-urlencode 'query=traces_span_metrics_duration_milliseconds_bucket' \
  --data-urlencode "start=$(($(date +%s)-400))" --data-urlencode "end=$(date +%s)" \
  | python3 -c "import sys,json;print(sum(len(g.get('exemplars',[])) for g in json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo 0)
[ "$EX" -gt 0 ] && ok "$EX exemplars stored (metric -> trace link)" || bad "no exemplars"

h "stage 4 — logs reach Loki, correlated by trace_id"
if [ -n "$TID" ]; then
  N=$(curl -s -G 'http://localhost:3110/loki/api/v1/query_range' \
    --data-urlencode "query={service=\"orders-api\"} | trace_id = \"$TID\"" \
    --data-urlencode "start=$(($(date +%s)-400))000000000" \
    --data-urlencode "end=$(date +%s)000000000" \
    | python3 -c "import sys,json;print(sum(len(s['values']) for s in json.load(sys.stdin)['data']['result']))" 2>/dev/null || echo 0)
  [ "$N" -gt 0 ] && ok "$N log lines retrieved by trace_id" || bad "trace_id -> logs returned nothing"
fi
LBL=$(curl -s http://localhost:3110/loki/api/v1/labels | python3 -c "import sys,json;print('trace_id' in json.load(sys.stdin).get('data',[]))")
[ "$LBL" = "False" ] && ok "trace_id is NOT an index label (cardinality safe)" \
                     || bad "trace_id leaked into Loki labels"

h "stage 5 — infra exporters"
for j in cadvisor node-exporter postgres-exporter redis-exporter otel-collector; do
  hs=$(curl -s 'http://localhost:9090/api/v1/targets?state=active' \
       | python3 -c "
import sys,json
for t in json.load(sys.stdin)['data']['activeTargets']:
    if t['labels']['job']=='$j': print(t['health']); break
else: print('missing')" 2>/dev/null)
  [ "$hs" = "up" ] && ok "target $j up" || bad "target $j is '$hs'"
done
[ "$(promq 'container_memory_usage_total_bytes{container_name=~"obslab-.*"}')" -gt 5 ] \
  && ok "per-container memory (docker_stats)" || bad "no per-container metrics"

h "stage 6 — dashboards"
for uid in red-service use-resources; do
  c=$(curl -s "http://localhost:3300/api/dashboards/uid/$uid" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['dashboard']['panels']))" 2>/dev/null || echo 0)
  [ "$c" -gt 0 ] && ok "dashboard $uid ($c panels)" || bad "dashboard $uid missing"
done
for uid in prometheus tempo loki; do
  curl -s "http://localhost:3300/api/datasources/uid/$uid" | grep -q '"uid"' \
    && ok "datasource $uid provisioned" || bad "datasource $uid missing"
done

h "stage 7 — alert rules"
R=$(curl -s http://localhost:9090/api/v1/rules | python3 -c "
import sys,json
print(sum(len(g['rules']) for g in json.load(sys.stdin)['data']['groups']))" 2>/dev/null || echo 0)
[ "$R" -ge 12 ] && ok "$R alert rules loaded" || bad "only $R alert rules"
BADR=$(curl -s http://localhost:9090/api/v1/rules | python3 -c "
import sys,json
print(sum(1 for g in json.load(sys.stdin)['data']['groups'] for r in g['rules'] if r['health'] not in ('ok','unknown')))" 2>/dev/null || echo 1)
[ "$BADR" = "0" ] && ok "all rules healthy" || bad "$BADR rules erroring"

printf "\n\033[1m%d passed, %d failed\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
