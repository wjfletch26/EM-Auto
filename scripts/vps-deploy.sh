#!/usr/bin/env bash
# Idempotent VPS deploy: preflight → flock lock → pull → install → build → manifest → pm2 reload → health.
# Environment: DEPLOY_PATH (optional, default pwd), PM2_APP_NAME (default deaton-outreach),
# GIT_SHA, GIT_REF, DEPLOYER for manifest; UNSUB_PORT for health curl (default 3000).
set -euo pipefail

APP_DIR="${DEPLOY_PATH:-$(pwd)}"
cd "$APP_DIR"

PM2_APP="${PM2_APP_NAME:-deaton-outreach}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-$APP_DIR/.deploy.lock}"
HEALTH_PORT="${UNSUB_PORT:-3000}"
MIN_DISK_MB="${MIN_DISK_MB:-200}"

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
      echo "ERROR: pm2 app '$PM2_APP' not found (first-time setup? run pm2 start ..., or SKIP_PM2_CHECK=1 once)" >&2
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

touch "$APP_DIR/.deploying"

echo "==> git pull"
git pull origin main

echo "==> npm install"
npm install

echo "==> npm run build"
npm run build

echo "==> deploy manifest"
export MANIFEST_APP_ENV="${MANIFEST_APP_ENV:-production}"
node scripts/write-deploy-manifest.mjs

rm -f "$APP_DIR/.deploying"

echo "==> pm2 reload $PM2_APP"
pm2 reload "$PM2_APP"

echo "==> health check"
sleep 2
curl -sf "http://127.0.0.1:${HEALTH_PORT}/health" | head -c 400 || true
echo ""
curl -sf -o /dev/null -w "HTTP %{http_code}\n" "http://127.0.0.1:${HEALTH_PORT}/health"

echo "Deploy finished."
