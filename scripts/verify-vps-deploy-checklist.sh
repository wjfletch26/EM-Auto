#!/usr/bin/env bash
# PR / manual checklist helper for scripts/vps-deploy.sh (flock + credentials path).
#
# Requires util-linux `flock` (Linux VPS, WSL2, or Docker — see docs/TESTING.md).
# Does not run git/npm/pm2 — only verifies locking and the credentials path convention.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/.deploy.lock.verify-$$"

cleanup() {
  rm -f "$LOCK"
}
trap cleanup EXIT

# ---- 1) Two processes: second flock -n must fail while first holds the lock ----
# (Same pattern as vps-deploy.sh: exec FD>file; flock -n FD.)
(
  exec 200>"$LOCK"
  flock -n 200 || exit 1
  sleep 4
) &
holder_pid=$!
sleep 0.4
exec 201>"$LOCK"
if flock -n 201; then
  echo "FAIL: second process should not acquire $LOCK while first holds it" >&2
  kill "$holder_pid" 2>/dev/null || true
  exit 1
fi
echo "OK: concurrent second deploy would exit with lock error (matches vps-deploy.sh)."

kill "$holder_pid" 2>/dev/null || true
wait "$holder_pid" 2>/dev/null || true

# ---- 2) credentials path matches vps-deploy.sh preflight ----
REL="credentials/service-account.json"
if [ -f "$ROOT/$REL" ]; then
  echo "OK: $REL exists under repo root (same relative path as vps-deploy preflight)."
else
  echo "SKIP: $REL not present on this host (normal for laptops). VPS layout: \$DEPLOY_PATH/$REL"
fi

echo "verify-vps-deploy-checklist.sh finished successfully."
