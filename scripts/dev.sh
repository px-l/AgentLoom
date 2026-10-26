#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || cp .env.example .env
pnpm install --frozen-lockfile
(cd services/api && uv sync --frozen --python 3.11)
docker compose up -d db --wait
(cd services/api && uv run --frozen alembic upgrade head && uv run --frozen python -m agentloom.seed)
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
(cd services/api && exec uv run --frozen uvicorn agentloom.main:app --host 127.0.0.1 --port 8000) & pids+=("$!")
(cd services/api && exec uv run --frozen python -m agentloom.worker) & pids+=("$!")
pnpm dev & pids+=("$!")
printf '\nAgentLoom: http://127.0.0.1:5173\nAPI docs: http://127.0.0.1:8000/docs\nCtrl+C stops app processes. PostgreSQL data stays in Docker volume.\n'
wait
