# Convenience wrappers. Everything here is a plain docker/curl command --
# run `make -n <target>` to see exactly what it would execute.

API  := http://localhost:8080
JSON := -H 'content-type: application/json'

.PHONY: help up down reset logs ps verify smoke \
        slow error cpu leak-buffer leak-heap nplusone slowdep flush heal

help:
	@echo "Stack:"
	@echo "  make up            build + start everything"
	@echo "  make ps            container status"
	@echo "  make logs          follow orders-api logs"
	@echo "  make down          stop (keeps data)"
	@echo "  make reset         stop + WIPE data (re-seeds Postgres)"
	@echo ""
	@echo "Checks:"
	@echo "  make verify        app-layer verification (19 assertions)"
	@echo "  make verify-stack  telemetry pipeline + correlation"
	@echo "  make verify-all    both"
	@echo "  make smoke         a little traffic through every endpoint"
	@echo ""
	@echo "Pathologies (make heal turns them all off):"
	@echo "  make slow          800ms on /products only"
	@echo "  make error         25% of requests return 500"
	@echo "  make cpu           250ms of CPU burn per request"
	@echo "  make leak-buffer   4MB/request OFF-heap  (heap metrics stay flat!)"
	@echo "  make leak-heap     4MB/request ON-heap"
	@echo "  make nplusone      1 query becomes 51"
	@echo "  make slowdep       payments-api takes 5s"
	@echo "  make flush         empty Redis right now"
	@echo "  make heal          reset everything + free leaked memory"

up:
	docker compose up -d --build
	@echo "waiting for health..." && sleep 15 && docker compose ps

down:
	docker compose down

reset:
	docker compose down -v

ps:
	docker compose ps

logs:
	docker compose logs -f orders-api

# ---- pathologies -----------------------------------------------------------

slow:
	@curl -s -XPOST $(API)/admin/pathologies $(JSON) \
	  -d '{"slow":{"enabled":true,"ms":800,"route":"/products"}}' >/dev/null
	@echo "slow ON  -> /products +800ms, /orders unaffected"

error:
	@curl -s -XPOST $(API)/admin/pathologies $(JSON) \
	  -d '{"errorRate":{"enabled":true,"pct":25}}' >/dev/null
	@echo "errorRate ON -> 25% of requests fail"

cpu:
	@curl -s -XPOST $(API)/admin/pathologies $(JSON) \
	  -d '{"cpuBurn":{"enabled":true,"ms":250}}' >/dev/null
	@echo "cpuBurn ON -> event loop blocked 250ms/request"

leak-buffer:
	@curl -s -XPOST $(API)/admin/pathologies $(JSON) \
	  -d '{"memLeak":{"enabled":true,"kbPerRequest":4096,"mode":"buffer"}}' >/dev/null
	@echo "memLeak ON (off-heap) -> watch RSS climb while heapUsed stays FLAT"

leak-heap:
	@curl -s -XPOST $(API)/admin/pathologies $(JSON) \
	  -d '{"memLeak":{"enabled":true,"kbPerRequest":4096,"mode":"heap"}}' >/dev/null
	@echo "memLeak ON (on-heap) -> watch RSS and heapUsed climb together"

nplusone:
	@curl -s -XPOST $(API)/admin/pathologies $(JSON) \
	  -d '{"nPlusOne":{"enabled":true}}' >/dev/null
	@echo "nPlusOne ON -> GET /orders?limit=50 now issues 51 queries"

slowdep:
	@curl -s -XPOST $(API)/admin/pathologies $(JSON) \
	  -d '{"slowDependency":{"enabled":true,"ms":5000}}' >/dev/null
	@echo "slowDependency ON -> /checkout waits 5s on payments-api"

flush:
	@curl -s -XPOST $(API)/admin/cache/flush

heal:
	@curl -s -XPOST $(API)/admin/pathologies/reset >/dev/null
	@curl -s -XPOST $(API)/admin/memory/release >/dev/null
	@echo "all pathologies off, leaked memory released"

# ---- verification ----------------------------------------------------------

smoke:
	@for i in $$(seq 1 20); do \
	  curl -s -o /dev/null "$(API)/products?limit=10"; \
	  curl -s -o /dev/null "$(API)/orders?limit=10"; \
	  curl -s -o /dev/null -XPOST $(API)/orders $(JSON) -d '{}'; \
	  curl -s -o /dev/null -XPOST $(API)/checkout $(JSON) -d '{}'; \
	done; echo "80 requests sent"

verify:
	@bash scripts/verify-stage1.sh

verify-stack:
	@bash scripts/verify-stack.sh

verify-all: verify verify-stack
