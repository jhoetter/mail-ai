#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRET="${HOF_SUBAPP_JWT_SECRET:-dev-only-not-for-prod-9c2f}"
PORT="${MAILAI_SMOKE_PORT:-18200}"
PROJECT="mailai-smoke-$RANDOM"
COMPOSE_FILE="$(mktemp -t mailai-smoke-compose.XXXXXX.yml)"
COOKIE_JAR="$(mktemp -t mailai-smoke-cookies.XXXXXX)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs --no-color mailai || true
  fi
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$COMPOSE_FILE" "$COOKIE_JAR"
  exit "$status"
}
trap cleanup EXIT

cat >"$COMPOSE_FILE" <<EOF
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: hofos
      POSTGRES_PASSWORD: hofos
      POSTGRES_DB: mailai
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hofos -d mailai"]
      interval: 2s
      timeout: 2s
      retries: 20

  mailai:
    build:
      context: "$ROOT_DIR"
      dockerfile: Dockerfile.subapp
    ports:
      - "$PORT:8200"
    environment:
      DATABASE_URL: postgresql://hofos:hofos@postgres:5432/mailai
      HOF_SUBAPP_JWT_SECRET: "$SECRET"
      HOF_SUBAPP_NAME: mailai
      HOF_ENV: dev
      NODE_ENV: production
      API_PORT: 8200
      MAILAI_SYNC_DISABLED: "1"
    depends_on:
      postgres:
        condition: service_healthy
EOF

mint_jwt() {
  node - "$SECRET" <<'JS'
const crypto = require("node:crypto");
const secret = process.argv[2];
function b64url(value) {
  const input = typeof value === "string" ? Buffer.from(value) : value;
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64url(JSON.stringify({
  aud: "mailai",
  sub: "smoke-user",
  tid: "smoke-tenant",
  email: "smoke@example.test",
  displayName: "Smoke User",
  exp: Math.floor(Date.now() / 1000) + 120,
}));
const sig = b64url(crypto.createHmac("sha256", Buffer.from(secret)).update(`${header}.${payload}`).digest());
console.log(`${header}.${payload}.${sig}`);
JS
}

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build

echo "Waiting for MailAI on :$PORT..."
for _ in $(seq 1 90); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "http://localhost:$PORT/api/health" >/dev/null

TOKEN="$(mint_jwt)"
curl -fsS -D - -o /dev/null -c "$COOKIE_JAR" \
  "http://localhost:$PORT/?__hof_jwt=$TOKEN" | grep -qi "set-cookie: hof_subapp_session="

curl -fsS -b "$COOKIE_JAR" "http://localhost:$PORT/" | grep -qi "<html"
curl -fsS -b "$COOKIE_JAR" "http://localhost:$PORT/api/whoami" | grep -q '"userId":"smoke-user"'

echo "MailAI smoke passed: /api/health, /, SSO handoff, /api/whoami"
