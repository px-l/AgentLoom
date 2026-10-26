#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Isolated test DB, never truncate the development DB.
docker compose exec -T db psql -U agentloom -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='agentloom_test'" | rg -q 1 || docker compose exec -T db createdb -U agentloom agentloom_test
(cd services/api && DATABASE_URL=postgresql+psycopg://agentloom:agentloom@127.0.0.1:5438/agentloom_test uv run --frozen pytest -q)
pnpm test
pnpm typecheck
pnpm build
