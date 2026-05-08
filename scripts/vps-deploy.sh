#!/usr/bin/env bash
# Idempotent VPS deploy: preflight → flock lock → git sync → install → build → manifest → pm2 reload → health.
#
# Environment (common):
#   DEPLOY_PATH — app directory (default: pwd)
#   PM2_APP_NAME — default deaton-outreach
#   DEPLOY_GIT_REF — branch deployed (default: main). Fetched from origin and checked out to match
#     origin/<ref> exactly (discards divergent local commits on that branch — normal for CI VPS).
#   DEPLOY_LOCK_FILE — flock path (default: $APP_DIR/.deploy.lock)
#   UNSUB_PORT — localhost port for /health (default: 3000)
#   HEALTH_WAIT_MAX_SECONDS — max time to wait for /health=200 after pm2 reload (default: 90).
#     Startup runs SMTP verify before listen(); 2s was often too short (CI saw HTTP 000 / curl exit 7).
#   HEALTH_RETRY_INTERVAL — seconds between attempts (default: 2)
#   MIN_DISK_MB — minimum free space on $APP_DIR filesystem (default: 200)
#   SKIP_PM2_CHECK=1 — skip `pm2 describe` (use once on first deploy only; do not leave set in automation)
# Manifest (see scripts/write-deploy-manifest.mjs):
#   GIT_SHA, GIT_REF, DEPLOYER, MANIFEST_APP_ENV, MANIFEST_DEPLOYMENT_STATUS, DEPLOY_MANIFEST_NAME
set -euo pipefail

APP_DIR="${DEPLOY_PATH:-$(pwd)}"
cd "$APP_DIR"

PM2_APP="${PM2_APP_NAME:-deaton-outreach}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-$APP_DIR/.deploy.lock}"
HEALTH_PORT="${UNSUB_PORT:-3000}"
HEALTH_WAIT_MAX_SECONDS="${HEALTH_WAIT_MAX_SECONDS:-90}"
HEALTH_RETRY_INTERVAL="${HEALTH_RETRY_INTERVAL:-2}"
MIN_DISK_MB="${MIN_DISK_MB:-200}"
DEPLOY_GIT_REF="${DEPLOY_GIT_REF:-main}"

cleanup() {
  rm -f "$APP_DIR/.deploying"
  flock -u 200 2>/dev/null || true
}

trap cleanup EXIT

preflight() {
  echo "==> Preflight"
  test -f "$APP_DIR/package.json" || {
    echo "ERROR: no package.json in $APP_DIR" >&2
    exit 1
  }
  test -f "$APP_DIR/credentials/service-account.json" || {
    echo "ERROR: missing credentials/service-account.json" >&2
    exit 1
  }

  if [ "${SKIP_PM2_CHECK:-}" != "1" ]; then
    if ! pm2 describe "$PM2_APP" >/dev/null 2>&1; then
      echo "ERROR: pm2 app '$PM2_APP' not found. See docs/OPERATIONS.md (First-time PM2 before vps-deploy.sh)." >&2
      echo "       One-time override: SKIP_PM2_CHECK=1 for a single run — do not leave this set in CI/cron." >&2
      exit 1
    fi
  fi

  if command -v df >/dev/null 2>&1; then
    avail=$(df -Pm "$APP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -n "${avail:-}" ] && [ "$avail" -lt "$MIN_DISK_MB" ]; then
      echo "ERROR: disk free ${avail}MiB under minimum ${MIN_DISK_MB}MiB" >&2
      exit 1
    fi
  fi

  echo "Preflight OK"
}

preflight

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "ERROR: another deploy holds $LOCK_FILE" >&2
  exit 1
fi

# Present until the script exits (success or failure); the EXIT trap deletes it and releases flock.
touch "$APP_DIR/.deploying"

# `git pull` without a strategy fails on Git ≥2.27 when local and origin diverge ("Need to specify how
# to reconcile"). CI deploys should match GitHub exactly — fetch and hard-reset the branch tip.
echo "==> git sync to origin/$DEPLOY_GIT_REF"
git fetch origin "$DEPLOY_GIT_REF"
git checkout -B "$DEPLOY_GIT_REF" "origin/$DEPLOY_GIT_REF"

echo "==> npm install"
npm install

echo "==> npm run build"
# Default Node heap is often too small for `tsc` + admin-ui on a small VPS (OOM during build).
export NODE_OPTIONS="--max-old-space-size=4096${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
npm run build

echo "==> deploy manifest"
export MANIFEST_APP_ENV="${MANIFEST_APP_ENV:-production}"
MANIFEST_SCRIPT="$APP_DIR/scripts/write-deploy-manifest.mjs"
if [ -f "$MANIFEST_SCRIPT" ]; then
  node "$MANIFEST_SCRIPT"
else
  echo "WARN: $MANIFEST_SCRIPT not found; skipping manifest write" >&2
fi

echo "==> pm2 reload $PM2_APP"
pm2 reload "$PM2_APP"

echo "==> health check"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
# Poll until Node accepts connections and returns 200. Single-shot curl after reload often failed with
# HTTP 000 while verifyConnection() still runs (see src/main.ts — web server starts after SMTP OK).
elapsed=0
last_code="000"
while [ "$elapsed" -lt "$HEALTH_WAIT_MAX_SECONDS" ]; do
  last_code=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
  if [ "$last_code" = "200" ]; then
    echo "HTTP $last_code (after ${elapsed}s)"
    curl -sf "$HEALTH_URL" | head -c 400 || true
    echo ""
    break
  fi
  echo "waiting for /health (HTTP ${last_code}, ${elapsed}s / ${HEALTH_WAIT_MAX_SECONDS}s max)..."
  sleep "$HEALTH_RETRY_INTERVAL"
  elapsed=$((elapsed + HEALTH_RETRY_INTERVAL))
done
if [ "$last_code" != "200" ]; then
  echo "ERROR: /health did not return 200 within ${HEALTH_WAIT_MAX_SECONDS}s (last HTTP ${last_code})" >&2
  echo "Hint: pm2 logs ${PM2_APP}; confirm UNSUB_PORT matches the running app." >&2
  exit 1
fi

echo "Deploy finished."
