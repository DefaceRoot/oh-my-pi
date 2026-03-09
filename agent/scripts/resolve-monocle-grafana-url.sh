#!/usr/bin/env bash
set -euo pipefail

candidates=(
  "http://monocle-testing-c2:3000"
  "http://192.168.6.172:3000"
)

for url in "${candidates[@]}"; do
  if curl -fsS --max-time 2 "${url}/api/health" >/dev/null; then
    printf '%s\n' "${url}"
    exit 0
  fi
done

exit 1
