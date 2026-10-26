#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  node scripts/setup-env.mjs "${1:-http://localhost:3080}"
fi

docker compose up --build -d --wait
echo "Rimo запущен. Адрес указан в BETTER_AUTH_URL файла .env."
docker compose ps
