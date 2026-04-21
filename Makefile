# mail-ai Makefile
# ----------------------------------------------------------------------
# Mirrors the collaboration-ai layout (`make dev` brings up infra +
# backend + web in one shot, `kill-ports` frees ours before re-running).
#
# Local "AI suite" port allocation (must match collaboration-ai's
# Makefile comment so all four repos coexist on one laptop):
#   3000 -> hof-os         (8000 backend)
#   3100 -> office-ai      (8100 backend)
#   3200 -> mail-ai        (8200 backend)  <-- this repo
#   3300 -> collaboration  (8300 backend)
# Realtime ws lives on 1235 (office-ai uses 1234).
# ----------------------------------------------------------------------

WEB_PORT ?= 3200
API_PORT ?= 8200
RT_PORT  ?= 1235
PNPM     := pnpm
COMPOSE  := docker compose -f infra/docker/compose.dev.yml

.PHONY: help install \
        stack-up stack-up-dovecot stack-down stack-logs stack-reset \
        build-libs dev dev-web dev-api dev-embed kill-ports \
        verify fixtures

help:
	@echo "Targets:"
	@echo "  install            Install JS dependencies (pnpm)"
	@echo "  stack-up           Bring up Postgres, Redis, Greenmail, MinIO"
	@echo "  stack-up-dovecot   Same as stack-up plus the optional Dovecot IMAP server"
	@echo "  stack-down         Stop the dev stack"
	@echo "  stack-logs         Follow the dev-stack logs"
	@echo "  stack-reset        Wipe stack volumes (DESTRUCTIVE)"
	@echo "  build-libs         Build all workspace libs (so tsx watchers can resolve them)"
	@echo "  dev                Boot stack + free ports + run web (:$(WEB_PORT)) + api (:$(API_PORT)); api embeds realtime ws on :$(RT_PORT)"
	@echo "  dev-web            Web UI only on :$(WEB_PORT)"
	@echo "  dev-api            API server only on :$(API_PORT)"
	@echo "  dev-embed          Vite embed-host smoke harness (separate from main dev loop)"
	@echo "  kill-ports         Free :$(WEB_PORT) :$(API_PORT) :$(RT_PORT) (matches collaboration-ai)"
	@echo "  verify             Lint + typecheck + tests + build (CI parity)"
	@echo "  fixtures           Generate the synthetic MIME fixture corpus"

install:
	$(PNPM) install

stack-up:
	$(COMPOSE) up -d

stack-up-dovecot:
	$(COMPOSE) --profile dovecot up -d

stack-down:
	$(COMPOSE) --profile dovecot down

stack-logs:
	$(COMPOSE) logs -f

stack-reset:
	$(COMPOSE) --profile dovecot down -v

# Frees the ports we own before spinning back up.
#
# A naive `lsof | kill` loses to tsx --watch and `next dev` because:
#   - tsx --watch forks a child node that holds the port; killing the
#     parent leaves the child orphaned and still listening.
#   - next dev spawns a Turbopack worker the same way.
#   - between kill and the next bind there's a tiny window in which the
#     supervisor can respawn.
#
# So we (1) kill every PID listening on each port, (2) ALSO pkill any
# tsx/next/turbo dev process whose argv mentions this workspace path,
# and (3) poll until the ports really are free (max ~3s). This makes
# `make dev` idempotent — re-running it from any state Just Works.
kill-ports:
	@PORTS="$(WEB_PORT) $(API_PORT) $(RT_PORT)"; \
	WS_TAG="$(CURDIR)"; \
	for _ in 1 2 3 4 5 6; do \
	  for p in $$PORTS; do \
	    pids=$$(lsof -ti :$$p 2>/dev/null); \
	    [ -n "$$pids" ] && kill -9 $$pids 2>/dev/null || true; \
	  done; \
	  pkill -9 -f "tsx.*$$WS_TAG"          2>/dev/null || true; \
	  pkill -9 -f "next-server.*$$WS_TAG"  2>/dev/null || true; \
	  pkill -9 -f "next dev.*$$WS_TAG"     2>/dev/null || true; \
	  pkill -9 -f "turbo run dev"          2>/dev/null || true; \
	  busy=""; \
	  for p in $$PORTS; do \
	    lsof -ti :$$p >/dev/null 2>&1 && busy="$$busy $$p"; \
	  done; \
	  [ -z "$$busy" ] && exit 0; \
	  sleep 0.5; \
	done; \
	echo "kill-ports: still in use after retries:$$busy" >&2; \
	exit 1

# tsx watchers in @mailai/server resolve @mailai/core, @mailai/overlay-db,
# etc. via their package "exports" → ./dist/index.js, so we build the libs
# once before launching the dev watchers. The watchers themselves only
# rebuild app code; lib changes need a `make build-libs` re-run (same
# split collaboration-ai uses).
build-libs:
	$(PNPM) turbo run build --filter './packages/**'

# NOTE: kill-ports must be the LAST prereq before launching turbo, so the
# ~few-second window between freeing ports and binding them isn't long
# enough for a stale watcher to sneak back in. build-libs runs first so
# kill-ports is closest to the actual `turbo run dev` invocation.
dev: stack-up build-libs kill-ports
	@echo "→ web        http://localhost:$(WEB_PORT)"
	@echo "→ api        http://localhost:$(API_PORT)"
	@echo "→ realtime   ws://localhost:$(RT_PORT)"
	WEB_PORT=$(WEB_PORT) API_PORT=$(API_PORT) MAILAI_RT_PORT=$(RT_PORT) \
	  $(PNPM) turbo run dev --parallel \
	    --filter @mailai/web \
	    --filter @mailai/server

dev-web:
	$(PNPM) --filter @mailai/web dev

dev-api: build-libs
	API_PORT=$(API_PORT) $(PNPM) --filter @mailai/server dev

# Embed smoke harness — requires `pnpm --filter @mailai/react-app build`
# first so Vite resolves the package via its built dist/.
dev-embed:
	$(PNPM) --filter @mailai/react-app build
	$(PNPM) --filter @mailai/embed-host dev

verify:
	$(PNPM) verify

fixtures:
	$(PNPM) fixtures:generate
