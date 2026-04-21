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

.PHONY: help \
        stack-up stack-down stack-logs stack-reset \
        dev dev-web dev-api kill-ports \
        verify fixtures

help:
	@echo "Targets:"
	@echo "  stack-up      Bring up Postgres, Redis, Dovecot, Greenmail, MinIO"
	@echo "  stack-down    Stop the dev stack"
	@echo "  stack-logs    Follow the dev-stack logs"
	@echo "  stack-reset   Wipe stack volumes (DESTRUCTIVE)"
	@echo "  dev           Boot stack + free ports + run web (:$(WEB_PORT)) + api (:$(API_PORT)) + realtime (:$(RT_PORT))"
	@echo "  dev-web       Web UI only on :$(WEB_PORT)"
	@echo "  dev-api       API server only on :$(API_PORT)"
	@echo "  kill-ports    Free :$(WEB_PORT) :$(API_PORT) :$(RT_PORT) (matches collaboration-ai)"
	@echo "  verify        Lint + typecheck + tests + build (CI parity)"
	@echo "  fixtures      Generate the synthetic MIME fixture corpus"

stack-up:
	$(COMPOSE) up -d

stack-down:
	$(COMPOSE) down

stack-logs:
	$(COMPOSE) logs -f

stack-reset:
	$(COMPOSE) down -v

# Frees the ports we own before spinning back up — matches
# collaboration-ai's `kill-ports` so re-running `make dev` after a
# Ctrl-C doesn't trip "address already in use".
kill-ports:
	@lsof -ti :$(WEB_PORT) | xargs kill -9 2>/dev/null || true
	@lsof -ti :$(API_PORT) | xargs kill -9 2>/dev/null || true
	@lsof -ti :$(RT_PORT)  | xargs kill -9 2>/dev/null || true

dev: stack-up kill-ports
	@echo "→ web        http://localhost:$(WEB_PORT)"
	@echo "→ api        http://localhost:$(API_PORT)"
	@echo "→ realtime   ws://localhost:$(RT_PORT)"
	WEB_PORT=$(WEB_PORT) API_PORT=$(API_PORT) MAILAI_RT_PORT=$(RT_PORT) \
	  $(PNPM) turbo run dev --parallel

dev-web:
	$(PNPM) --filter @mailai/web dev

dev-api:
	API_PORT=$(API_PORT) $(PNPM) --filter @mailai/server dev

verify:
	$(PNPM) verify

fixtures:
	$(PNPM) fixtures:generate
