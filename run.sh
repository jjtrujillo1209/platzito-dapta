#!/usr/bin/env bash
# Desarrollo: backend en :8700 y frontend (Vite) en :5173 con proxy a la API.
set -euo pipefail
cd "$(dirname "$0")"
[ -f backend/.env ] || cp backend/.env.example backend/.env
if [ ! -d backend/.venv ]; then
  python3.12 -m venv backend/.venv
  backend/.venv/bin/pip install -q -r backend/requirements.txt -r backend/requirements-dev.txt
fi
[ -d frontend/node_modules ] || (cd frontend && npm ci)
(cd backend && .venv/bin/uvicorn app.main:app --reload --port 8700) &
API=$!
trap 'kill $API 2>/dev/null' EXIT
cd frontend && npm run dev
