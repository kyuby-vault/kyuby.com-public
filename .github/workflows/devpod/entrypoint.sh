#!/usr/bin/env bash
set -euo pipefail
cd /workspace
test "$(id -u)" != 0 || { echo 'DevPod commands must be non-root.' >&2; exit 1; }
test "$(node --version)" = v22.23.2
current=$(sha256sum package-lock.json | cut -d ' ' -f1)
test "$current" = "$(cat /opt/kyuby-lock-sha)" || { echo 'Lockfile changed: run make image.' >&2; exit 1; }
if [[ ! -f node_modules/.kyuby-lock-sha ]] || [[ "$current" != "$(cat node_modules/.kyuby-lock-sha)" ]]; then
  npm ci --ignore-scripts --offline
  printf '%s\n' "$current" > node_modules/.kyuby-lock-sha
fi
exec "$@"
