#!/usr/bin/env bash
#
# Generate a fresh test credential for the TURN server.
#
# Run on your laptop (or VM) once you have the TURN_SHARED_SECRET from
# 02-install-coturn.sh. Useful for manual testing in trickle-ice.
#
# Usage:
#   TURN_DOMAIN=turn.filetransfernow.com \
#   TURN_SHARED_SECRET='abc123...' \
#   ./03-test.sh
#
# Output: a fresh username + credential pair valid for 10 minutes, plus the
# trickle-ice tester URL pre-filled so you can paste & test in one click.
#

set -euo pipefail

TURN_DOMAIN="${TURN_DOMAIN:?Set TURN_DOMAIN, e.g. TURN_DOMAIN=turn.filetransfernow.com}"
TURN_SHARED_SECRET="${TURN_SHARED_SECRET:?Set TURN_SHARED_SECRET from /etc/turnserver.conf}"
TTL_SECONDS="${TTL_SECONDS:-600}"

EXPIRY=$(($(date +%s) + TTL_SECONDS))
USERNAME="${EXPIRY}:test"
CREDENTIAL=$(echo -n "$USERNAME" | openssl dgst -sha1 -hmac "$TURN_SHARED_SECRET" -binary | base64)

cat <<EOF
━━ Fresh TURN credential (expires in ${TTL_SECONDS}s) ━━

  URI:        turn:${TURN_DOMAIN}:3478
  URI (TLS):  turns:${TURN_DOMAIN}:5349?transport=tcp
  Username:   ${USERNAME}
  Credential: ${CREDENTIAL}

━━ Test in browser ━━

  Open: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

  1. Click "Remove server" to clear the default Google STUN
  2. Click "Add server" and paste the URI/Username/Credential above
  3. Click "Gather candidates"
  4. ✓ Success = at least one Type=relay row appears
     ✗ Fail    = only host/srflx → check coturn logs on the VM

━━ Verify the live coturn server is reachable ━━

  Without TURN auth (cheap STUN binding test):

  $(command -v stunclient >/dev/null && echo "  stunclient ${TURN_DOMAIN} 3478" || echo "  # install: sudo apt install stuntman-client && stunclient ${TURN_DOMAIN} 3478")

EOF
