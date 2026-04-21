# mail-ai Makefile
# ----------------------------------------------------------------------
# Default Next.js port 3200 (one digit above office-ai's 3100, two above
# hof-os' 3000) so all three coexist on a developer laptop without
# port-stomping. Override with `PORT=3000 make dev` if running mail-ai
# in isolation. Realtime ws defaults to 1235 (office-ai uses 1234).
# ----------------------------------------------------------------------

PORT ?= 3200
RT_PORT ?= 1235
COMPOSE := docker compose -f infra/docker/compose.dev.yml

.PHONY: help
help:
	@echo "Targets:"
	@echo "  make stack-up       Bring up Postgres, Redis, Dovecot, Greenmail, MinIO"
	@echo "  make stack-down     Stop the dev stack"
	@echo "  make stack-logs     Follow the dev-stack logs"
	@echo "  make dev            Boot stack + run apps in watch mode"
	@echo "  make verify         Lint + typecheck + tests + build (CI parity)"
	@echo "  make fixtures       Generate the synthetic MIME fixture corpus"
	@echo "  make stack-reset    Wipe stack volumes (DESTRUCTIVE)"

.PHONY: stack-up
stack-up:
	$(COMPOSE) up -d

.PHONY: stack-down
stack-down:
	$(COMPOSE) down

.PHONY: stack-logs
stack-logs:
	$(COMPOSE) logs -f

.PHONY: stack-reset
stack-reset:
	$(COMPOSE) down -v

.PHONY: dev
dev: stack-up
	@echo "→ next dev          http://localhost:$(PORT)"
	@echo "→ realtime ws       ws://localhost:$(RT_PORT)"
	PORT=$(PORT) MAILAI_RT_PORT=$(RT_PORT) pnpm turbo run dev --parallel

.PHONY: verify
verify:
	pnpm verify

.PHONY: fixtures
fixtures:
	pnpm fixtures:generate
