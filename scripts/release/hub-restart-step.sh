#!/usr/bin/env bash
#
# scripts/release/hub-restart-step.sh — the post-release "restart the local web-hub" step.
#
# Called by release.sh right after `gh release create` succeeded (skip with --skip-hub-restart).
# It runs scripts/release/restart-hub.ts, which asks the hub running on THIS machine to restart the
# way `/webhub restart` does (see that file's header for semantics and skip rules). The hub now
# reads its own version from disk (src/web-hub/hub/self-version.ts), so whichever pi session
# respawns it afterwards brings it up at the released version — which is what stops the web UI
# from reporting "version differs from backend" after every release.
#
# CONTRACT: best-effort. This script ALWAYS exits 0 — a missing tsx, a hub that will not restart,
# a timeout, or any crash only prints a WARN. A release that is already tagged, pushed and
# published must never be reported as failed by a convenience step.
#
# Seams (tests only): PI_TOOLKIT_TSX (runner binary), PI_TOOLKIT_HUB_RESTART_TIMEOUT (seconds,
# default 90 — above restart-hub.ts's own 20 s new-hub wait + 10 s of ack/exit waits).

set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TSX="${PI_TOOLKIT_TSX:-$ROOT/node_modules/.bin/tsx}"
LIMIT="${PI_TOOLKIT_HUB_RESTART_TIMEOUT:-90}"
[[ "$LIMIT" =~ ^[0-9]+$ ]] || LIMIT=90

info() { echo "[INFO] $*"; }
warn() { echo "[WARN] $*"; }

if [[ ! -x "$TSX" ]]; then
  warn "hub restart skipped: tsx not found at $TSX (run npm install); restart the hub by hand with /webhub restart"
  exit 0
fi

info "restarting the local web-hub (timeout ${LIMIT}s; skip with --skip-hub-restart)"
if timeout -k 5 "$LIMIT" "$TSX" "$ROOT/scripts/release/restart-hub.ts"; then
  :
else
  rc=$?
  if [[ $rc -eq 124 || $rc -eq 137 ]]; then
    warn "hub restart timed out after ${LIMIT}s — restart it by hand with /webhub restart"
  else
    warn "hub restart did not complete (exit $rc) — restart it by hand with /webhub restart"
  fi
fi
exit 0
