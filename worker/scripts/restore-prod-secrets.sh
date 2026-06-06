#!/usr/bin/env bash
#
# Restore production Cloudflare Worker secrets.
#
# WHY THIS EXISTS: `wrangler secret put` is silently overwriteable. If you
# accidentally pipe an empty string in (e.g. `echo $UNSET | wrangler secret put X`),
# the secret becomes "" and /turn falls back to STUN-only. This script is the
# canonical "set them back to known-good values" command.
#
# PREREQ: copy worker/.dev.vars.example → worker/.dev.vars (gitignored) and
# fill in:
#   - TURN_SHARED_SECRET     (the coturn HMAC key from /etc/turnserver.conf)
#   - CLOUDFLARE_API_TOKEN   (custom token: Workers Scripts:Edit + User Details:Read)
#   - CLOUDFLARE_ACCOUNT_ID  (from dash.cloudflare.com URL)
#
# With both Cloudflare vars set, wrangler skips the interactive OAuth login —
# script runs fully non-interactively. Useful in CI / when you don't want to
# re-auth via browser every time.
#
# USAGE:
#   cd worker
#   ./scripts/restore-prod-secrets.sh
#
# Idempotent — safe to re-run anytime.

set -euo pipefail

WORKER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKER_DIR"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1;34m'; N='\033[0m'
step() { echo -e "\n${B}==>${N} $*"; }
ok()   { echo -e "${G}✓${N} $*"; }
warn() { echo -e "${Y}⚠${N} $*"; }
err()  { echo -e "${R}✗${N} $*"; exit 1; }

step "Loading .dev.vars"
[[ -f .dev.vars ]] || err ".dev.vars missing — copy from .dev.vars.example and fill in TURN_SHARED_SECRET"

# shellcheck disable=SC1091
set -o allexport
source .dev.vars
set +o allexport

[[ -n "${TURN_SHARED_SECRET:-}" ]] || err "TURN_SHARED_SECRET empty in .dev.vars"
[[ "${TURN_SHARED_SECRET}" != "paste-coturn-static-auth-secret-here" ]] || err "TURN_SHARED_SECRET still placeholder — fill in .dev.vars"

ok "Loaded TURN_SHARED_SECRET (len=${#TURN_SHARED_SECRET})"

# ---- Cloudflare auth ----
# Prefer API-token auth (non-interactive) if provided. Falls back to OAuth
# (browser popup the first time, cached after) if no token in .dev.vars.
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  [[ "$CLOUDFLARE_API_TOKEN" != "paste-cloudflare-api-token-here" ]] \
    || err "CLOUDFLARE_API_TOKEN still placeholder — fill in .dev.vars"
  export CLOUDFLARE_API_TOKEN
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    export CLOUDFLARE_ACCOUNT_ID
    ok "Using CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID for auth"
  else
    warn "CLOUDFLARE_API_TOKEN set but CLOUDFLARE_ACCOUNT_ID missing — wrangler will guess (only works with single-account tokens)"
  fi
else
  warn "CLOUDFLARE_API_TOKEN not set in .dev.vars — wrangler will try cached OAuth login"
  warn "If you see a browser auth popup, run 'npx wrangler login' once OR add CLOUDFLARE_API_TOKEN to .dev.vars (see .dev.vars.example)"
fi

step "Setting TURN_SHARED_SECRET on production worker"
echo -n "$TURN_SHARED_SECRET" | npx wrangler secret put TURN_SHARED_SECRET
ok "Set"

step "Deploying worker (re-applies wrangler.toml [vars])"
npx wrangler deploy 2>&1 | tail -5
ok "Deployed"

step "Verifying /turn"
WORKER_URL="https://p2pdatasharing.shresth-2tripathi.workers.dev"
RESP=$(curl -s -H "Origin: https://filetransfernow.com" "$WORKER_URL/turn")
PROVIDER=$(echo "$RESP" | grep -oE '"provider":"[^"]+"' | head -1 || echo "")

if [[ "$PROVIDER" == '"provider":"self-hosted"' ]]; then
  ok "✅ /turn returns provider: self-hosted — TURN is LIVE"
else
  echo "$RESP" | head -c 500
  err "/turn returned wrong provider: $PROVIDER"
fi
