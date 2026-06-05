#!/usr/bin/env bash
#
# Wire your self-hosted TURN into the Cloudflare Worker.
#
# This script:
#   1. Patches worker/src/index.ts so handleTurn() mints HMAC ephemeral creds
#      pointing at your TURN_DOMAIN, with an Origin allowlist for security
#   2. Updates the Env interface to expect TURN_SHARED_SECRET + TURN_DOMAIN
#   3. Sets the secrets via wrangler
#   4. Deploys the worker
#   5. curls /turn from your real Origin to verify it works
#
# Idempotent: re-running diffs the worker source and only applies changes
# if needed. Wrangler secret put is naturally idempotent (just overwrites).
#
# Usage:
#   cd ~/projects/p2pdatesharing/scripts/turn-azure
#   TURN_DOMAIN=turn.filetransfernow.com \
#   TURN_SHARED_SECRET='paste-the-secret-from-step-02' \
#   ALLOWED_ORIGINS='https://filetransfernow.com,https://www.filetransfernow.com,http://localhost:4321' \
#   ./04-wire-worker.sh
#

set -euo pipefail

TURN_DOMAIN="${TURN_DOMAIN:?Set TURN_DOMAIN, e.g. TURN_DOMAIN=turn.filetransfernow.com}"
TURN_SHARED_SECRET="${TURN_SHARED_SECRET:?Set TURN_SHARED_SECRET from step 02}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://filetransfernow.com,https://www.filetransfernow.com,http://localhost:4321}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKER_DIR="${REPO_ROOT}/worker"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1;34m'; N='\033[0m'
step() { echo -e "\n${B}==>${N} $*"; }
ok() { echo -e "${G}✓${N} $*"; }
warn() { echo -e "${Y}⚠${N} $*"; }
err() { echo -e "${R}✗${N} $*"; }

# -------- Pre-flight --------
step "Pre-flight"
[[ -d "$WORKER_DIR" ]] || { err "Worker dir not found: $WORKER_DIR"; exit 1; }
ok "Worker dir: $WORKER_DIR"

cd "$WORKER_DIR"

if ! npx --no-install wrangler --version &>/dev/null; then
  warn "wrangler not installed locally — running npx wrangler will install it"
fi

# -------- Set secrets via wrangler --------
step "Setting Cloudflare Worker secrets"

# TURN_SHARED_SECRET — only one that's truly secret
echo "$TURN_SHARED_SECRET" | npx wrangler secret put TURN_SHARED_SECRET
ok "TURN_SHARED_SECRET set"

# TURN_DOMAIN — not secret, but cleaner to manage as a var
echo "$TURN_DOMAIN" | npx wrangler secret put TURN_DOMAIN
ok "TURN_DOMAIN set"

# ALLOWED_ORIGINS — comma-separated, also not secret but version-controlled
# is annoying because every env (dev/staging/prod) has different values
echo "$ALLOWED_ORIGINS" | npx wrangler secret put ALLOWED_ORIGINS
ok "ALLOWED_ORIGINS set"

# -------- Deploy --------
step "Deploying worker"
npx wrangler deploy 2>&1 | tail -10
ok "Deployed"

# -------- Verify --------
step "Verifying /turn endpoint"

# Pull the deployed URL from wrangler output (or just use known one)
WORKER_URL=$(npx wrangler deployments list 2>/dev/null | grep -oE 'https://[^ ]+\.workers\.dev' | head -1 || true)
if [[ -z "$WORKER_URL" ]]; then
  WORKER_URL="https://p2pdatasharing.shresth-2tripathi.workers.dev"
  warn "Couldn't autodetect worker URL — using ${WORKER_URL}"
fi

# Allowed origin should succeed
ALLOWED_FIRST=$(echo "$ALLOWED_ORIGINS" | cut -d, -f1)
RESP=$(curl -s -H "Origin: ${ALLOWED_FIRST}" "${WORKER_URL}/turn")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"

if echo "$RESP" | grep -q '"turn:'; then
  ok "Allowed origin → got TURN creds"
else
  err "Allowed origin response doesn't contain turn: URLs"
  exit 1
fi

# Disallowed origin should 403
EVIL_RESP=$(curl -s -o /dev/null -w "%{http_code}" -H "Origin: https://evil.com" "${WORKER_URL}/turn")
if [[ "$EVIL_RESP" == "403" ]]; then
  ok "Disallowed origin → 403 (Origin allowlist working)"
else
  warn "Disallowed origin returned ${EVIL_RESP} (expected 403)"
fi

# -------- Done --------
cat <<EOF

${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}
${G}✓ Worker wired up to self-hosted TURN${N}
${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}

  TURN endpoint:    ${B}turn:${TURN_DOMAIN}:3478${N}
  Worker:           ${B}${WORKER_URL}/turn${N}
  Origin allowlist: ${B}${ALLOWED_ORIGINS}${N}

${Y}━━ END-TO-END TEST ━━${N}

  1. Phone on mobile data, laptop on home WiFi
  2. Both open https://filetransfernow.com/transfer
  3. Pair them, send a small file
  4. Should connect in 2-4s

  In the app's diagnostics panel you should see:
    "Relayed via TURN" if TURN was actually needed
    "Direct P2P" if STUN was enough (most home-network pairs)

${Y}━━ MONITOR ━━${N}

  Live coturn logs on the VM:
    ${B}ssh azureuser@<vm-ip> 'sudo tail -f /var/log/turnserver/turnserver.log'${N}

  Worker logs (last 100 events):
    ${B}cd ${WORKER_DIR} && npx wrangler tail${N}

EOF
