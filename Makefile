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

# Auto-load .env so `make dev` picks up NANGO_SECRET_KEY, OAuth client
# creds, DATABASE_URL, etc. without each developer needing to remember
# `set -a; . ./.env; set +a` first. The `-` means "don't fail if the
# file is missing" (CI, fresh clones). `export` then re-exports every
# variable defined above this line to all child processes (pnpm, turbo,
# tsx, vite), which is what the API server and Vite runtime read from.
# `hof-os` → `make dev-native SUBAPP=mailai` exports DATABASE_URL (shared Postgres)
# before running make. `-include .env` must not overwrite it (or clear JWT).
_HOF_OS_IMPORT_DB := $(DATABASE_URL)
_HOF_OS_IMPORT_JWT := $(HOF_SUBAPP_JWT_SECRET)
_HOF_OS_IMPORT_S3_ENDPOINT := $(S3_ENDPOINT)
_HOF_OS_IMPORT_S3_ACCESS_KEY := $(S3_ACCESS_KEY)
_HOF_OS_IMPORT_S3_SECRET_KEY := $(S3_SECRET_KEY)
_HOF_OS_IMPORT_S3_BUCKET := $(S3_BUCKET)
_HOF_OS_IMPORT_S3_REGION := $(S3_REGION)
_HOF_OS_IMPORT_S3_KEY_PREFIX := $(S3_KEY_PREFIX)
-include .env
export
ifneq ($(and $(strip $(_HOF_OS_IMPORT_JWT)),$(strip $(_HOF_OS_IMPORT_DB))),)
DATABASE_URL := $(_HOF_OS_IMPORT_DB)
HOF_SUBAPP_JWT_SECRET := $(_HOF_OS_IMPORT_JWT)
HOFOS_SUBAPP_NATIVE := 1
endif
ifneq ($(strip $(_HOF_OS_IMPORT_S3_ENDPOINT)),)
S3_ENDPOINT := $(_HOF_OS_IMPORT_S3_ENDPOINT)
endif
ifneq ($(strip $(_HOF_OS_IMPORT_S3_ACCESS_KEY)),)
S3_ACCESS_KEY := $(_HOF_OS_IMPORT_S3_ACCESS_KEY)
endif
ifneq ($(strip $(_HOF_OS_IMPORT_S3_SECRET_KEY)),)
S3_SECRET_KEY := $(_HOF_OS_IMPORT_S3_SECRET_KEY)
endif
ifneq ($(strip $(_HOF_OS_IMPORT_S3_BUCKET)),)
S3_BUCKET := $(_HOF_OS_IMPORT_S3_BUCKET)
endif
ifneq ($(strip $(_HOF_OS_IMPORT_S3_REGION)),)
S3_REGION := $(_HOF_OS_IMPORT_S3_REGION)
endif
ifneq ($(strip $(_HOF_OS_IMPORT_S3_KEY_PREFIX)),)
S3_KEY_PREFIX := $(_HOF_OS_IMPORT_S3_KEY_PREFIX)
endif

WEB_PORT ?= 3200
API_PORT ?= 8200
# Realtime ws merged onto API_PORT/ws since v0.1.4. Operators who
# need the legacy split-port layout can `export MAILAI_RT_PORT=1235`
# before `make dev`; an unset value (the default) keeps everything
# on a single port and works with the host-app proxy story. RT_PORT
# is still kept as a Makefile var so kill-ports / dev-wait can poll
# the legacy port for split-process deployments — harmless when no
# one's listening on it.
RT_PORT  ?= 1235
PNPM     := pnpm
COMPOSE  := docker compose -f infra/docker/compose.dev.yml

# Where `make dev` parks the detached dev-stack process + its log. Both
# files are gitignored. Don't move these without updating .gitignore.
DEV_LOG  := .mailai-dev.log
DEV_PID  := .mailai-dev.pid

MAILAI_NEEDS_LOCAL_MINIO := 0
ifneq (,$(findstring localhost,$(S3_ENDPOINT)))
MAILAI_NEEDS_LOCAL_MINIO := 1
endif
ifneq (,$(findstring 127.0.0.1,$(S3_ENDPOINT)))
MAILAI_NEEDS_LOCAL_MINIO := 1
endif

.PHONY: help install \
        stack-up stack-up-minio stack-up-dovecot stack-down stack-logs stack-reset \
        build-libs dev dev-wait dev-logs dev-stop dev-web dev-api dev-embed kill-ports \
        reset-db verify fixtures

help:
	@echo "Targets:"
	@echo "  install            Install JS dependencies (pnpm)"
	@echo "  stack-up           Bring up Postgres, Redis, Greenmail, MinIO"
	@echo "  stack-up-minio     MinIO only (S3 :9200) — needed for attachments when Postgres comes from elsewhere (hof-os native)"
	@echo "  stack-up-dovecot   Same as stack-up plus the optional Dovecot IMAP server"
	@echo "  stack-down         Stop the dev stack"
	@echo "  stack-logs         Follow the dev-stack logs"
	@echo "  stack-reset        Wipe stack volumes (DESTRUCTIVE)"
	@echo "  build-libs         Build all workspace libs (so tsx watchers can resolve them)"
	@echo "  dev                Boot stack, verify health on web/api/ws, then stream logs (servers detach + survive a kill)"
	@echo "  dev-logs           Re-attach to a running \`make dev\` log stream"
	@echo "  dev-stop           Stop the detached dev stack started by \`make dev\`"
	@echo "  dev-web            Web UI only on :$(WEB_PORT) (foreground, no detach)"
	@echo "  dev-api            API server only on :$(API_PORT) (foreground, no detach)"
	@echo "  dev-embed          Vite embed-host smoke harness (separate from main dev loop)"
	@echo "  kill-ports         Free :$(WEB_PORT) :$(API_PORT) :$(RT_PORT) (matches collaboration-ai)"
	@echo "  reset-db           Drop & recreate the dev Postgres schema (clears all data, keeps volumes; migrations replay on next \`make dev\`)"
	@echo "  verify             Lint + typecheck + tests + build (CI parity)"
	@echo "  fixtures           Generate the synthetic MIME fixture corpus"

install:
	$(PNPM) install

stack-up:
	$(COMPOSE) up -d

# Attachment blobs / presigns hit S3 (MinIO on :9200 by default).
# `HOFOS_SUBAPP_NATIVE=1` skips full `stack-up` so Postgres can come from
# hof-os — but inline images still need MinIO unless S3_* is unset.
stack-up-minio:
	@echo "→ MinIO (:9200) for attachment storage..."
	@$(COMPOSE) up -d minio

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
# A naive `lsof | kill` loses to tsx --watch and `vite` because:
#   - tsx --watch forks a child node that holds the port; killing the
#     parent leaves the child orphaned and still listening.
#   - vite spawns a worker process the same way.
#   - between kill and the next bind there's a tiny window in which the
#     supervisor can respawn.
#
# So we (1) kill every PID listening on each port, (2) ALSO pkill any
# tsx/vite/turbo dev process whose argv mentions this workspace path,
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
	  pkill -9 -f "vite.*$$WS_TAG"         2>/dev/null || true; \
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

# `make dev` is split into three phases so "everything works" is *proven*,
# not assumed:
#
#   1. boot   — stack-up (+ MinIO-only when native) + build-libs + kill-ports +
#               start the dev servers DETACHED
#               servers DETACHED (`(nohup ... &)` in a subshell so the
#               child is reparented to launchd; an external SIGKILL on
#               `make` itself can no longer take the dev stack down).
#               stdout+stderr go to .mailai-dev.log; pid is captured
#               into .mailai-dev.pid for `make dev-stop`.
#
#   2. verify — `dev-wait` polls `/api/health`, `:WEB_PORT/`, and a TCP
#               connect on `:RT_PORT` until ALL three respond (timeout
#               60s). Only when all three are green do we declare the
#               stack healthy. If any fails we tail the log, run
#               `dev-stop`, and exit non-zero.
#
#   3. tail   — `exec tail -F .mailai-dev.log` so the make process is
#               REPLACED by tail. If the user closes the terminal /
#               IDE kills the foreground command / OOM, only tail
#               dies — the dev servers keep running. Re-attach any
#               time via `make dev-logs`; stop via `make dev-stop`.
#
# kill-ports must be the LAST prereq before the launch so the ~few-second
# window between freeing ports and binding them isn't long enough for a
# stale watcher to sneak back in.
ifeq ($(HOFOS_SUBAPP_NATIVE),1)
ifeq ($(MAILAI_NEEDS_LOCAL_MINIO),1)
dev: stack-up-minio build-libs kill-ports
else
dev: build-libs kill-ports
endif
else
dev: stack-up build-libs kill-ports
endif
	@rm -f $(DEV_LOG) $(DEV_PID)
	@echo "→ Booting dev stack (detached; logs → $(DEV_LOG))..."
	@( WEB_PORT=$(WEB_PORT) API_PORT=$(API_PORT) \
	   nohup $(PNPM) turbo run dev --parallel \
	     --filter @mailai/web \
	     --filter @mailai/server \
	     >"$(DEV_LOG)" 2>&1 & echo $$! >"$(DEV_PID)" )
	@$(MAKE) --no-print-directory dev-wait || ( \
	  echo ""; \
	  echo "❌ dev: services failed to come up healthy in 60s."; \
	  echo "─── last 80 log lines ($(DEV_LOG)) ─────────────────────────────"; \
	  tail -n 80 "$(DEV_LOG)" || true; \
	  echo "────────────────────────────────────────────────────────────────"; \
	  $(MAKE) --no-print-directory dev-stop >/dev/null 2>&1 || true; \
	  exit 1 \
	)
	@echo ""
	@echo "✅ web        http://localhost:$(WEB_PORT)"
	@echo "✅ api        http://localhost:$(API_PORT)/api/health"
	@echo "✅ realtime   ws://localhost:$(API_PORT)/ws (merged) — set MAILAI_RT_PORT for legacy split"
	@echo ""
	@echo "Streaming logs. Ctrl-C / closing this terminal only stops the tail —"
	@echo "the dev stack keeps running. Re-attach: \`make dev-logs\`. Stop: \`make dev-stop\`."
	@echo ""
	@exec tail -F "$(DEV_LOG)"

# Polls the local endpoints until each responds OR the deadline
# (60s) elapses. Prints a tick per service as it comes up so the user
# sees progress instead of a blank wait. The realtime check is a
# soft pass when the legacy split-port isn't set — the merged WS
# rides on the API port and is implicitly green once /api/health is.
dev-wait:
	@deadline=$$(($$(date +%s) + 60)); \
	api=0; web=0; rt=0; \
	if [ -z "$$MAILAI_RT_PORT" ]; then rt=1; echo "  ✓ ws    merged on :$(API_PORT)/ws"; fi; \
	while [ "$$(date +%s)" -lt "$$deadline" ]; do \
	  if [ "$$api" = 0 ] && curl -fsS -o /dev/null --max-time 1 \
	      http://127.0.0.1:$(API_PORT)/api/health 2>/dev/null; then \
	    api=1; echo "  ✓ api   :$(API_PORT)/api/health"; \
	  fi; \
	  if [ "$$web" = 0 ] && curl -fsS -o /dev/null --max-time 1 \
	      http://127.0.0.1:$(WEB_PORT)/ 2>/dev/null; then \
	    web=1; echo "  ✓ web   :$(WEB_PORT)/"; \
	  fi; \
	  if [ "$$rt" = 0 ] && nc -z -w 1 127.0.0.1 $(RT_PORT) >/dev/null 2>&1; then \
	    rt=1; echo "  ✓ ws    :$(RT_PORT) (tcp)"; \
	  fi; \
	  if [ "$$api" = 1 ] && [ "$$web" = 1 ] && [ "$$rt" = 1 ]; then \
	    exit 0; \
	  fi; \
	  sleep 0.5; \
	done; \
	echo "  api=$$api web=$$web rt=$$rt (1 = healthy)" >&2; \
	exit 1

# Re-attach to the streaming dev log. Useful after the foreground tail
# was killed (terminal close, IDE timeout) but the detached servers
# kept running.
dev-logs:
	@test -f "$(DEV_LOG)" || (echo "no $(DEV_LOG) — run \`make dev\` first" >&2; exit 1)
	@exec tail -F "$(DEV_LOG)"

# Stop the detached dev stack: kill the captured turbo PID + its
# descendants, then run `kill-ports` to mop up any orphaned watchers.
# Idempotent — safe to run when nothing is up.
dev-stop:
	@if [ -f "$(DEV_PID)" ]; then \
	  pid=$$(cat "$(DEV_PID)"); \
	  if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
	    echo "Stopping detached dev stack (pid $$pid + descendants)..."; \
	    pkill -9 -P "$$pid" 2>/dev/null || true; \
	    kill -9 "$$pid" 2>/dev/null || true; \
	  fi; \
	  rm -f "$(DEV_PID)"; \
	fi
	@$(MAKE) --no-print-directory kill-ports

dev-web:
	$(PNPM) --filter @mailai/web dev

dev-api: build-libs
	API_PORT=$(API_PORT) $(PNPM) --filter @mailai/server dev

# Embed smoke harness — requires `pnpm --filter @mailai/react-app build`
# first so Vite resolves the package via its built dist/.
dev-embed:
	$(PNPM) --filter @mailai/react-app build
	$(PNPM) --filter @mailai/embed-host dev

# Wipe every row in the dev Postgres without nuking the docker volume.
#
# Stops the detached dev stack first so the API isn't holding live PG
# connections (DROP SCHEMA blocks behind them and we'd just hang). Then
# ensures Postgres is up, waits for it to be ready, and drops + recreates
# the `public` schema. That nukes every table AND the `schema_migrations`
# bookkeeping table, so the next `make dev` boot replays every migration
# from scratch via runMigrations() in @mailai/overlay-db.
#
# MinIO is left alone on purpose — orphaned attachment blobs are harmless
# in dev (the bucket is reused, no DB row points at them anymore). For a
# full nuke including object storage volumes, use `make stack-reset`.
reset-db: dev-stop stack-up
	@echo "→ Waiting for postgres to accept connections..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	  $(COMPOSE) exec -T postgres pg_isready -U mailai -q && break; \
	  sleep 1; \
	  if [ $$i = 15 ]; then \
	    echo "reset-db: postgres never became ready" >&2; exit 1; \
	  fi; \
	done
	@echo "→ Dropping & recreating public schema in dev DB (mailai)..."
	@$(COMPOSE) exec -T postgres psql -U mailai -d mailai -v ON_ERROR_STOP=1 -q -c \
	  "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO mailai; GRANT ALL ON SCHEMA public TO public;"
	@echo ""
	@echo "✅ Dev database wiped. Run \`make dev\` to replay migrations and start fresh."

verify:
	$(PNPM) verify

fixtures:
	$(PNPM) fixtures:generate
