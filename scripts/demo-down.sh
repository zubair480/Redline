#!/usr/bin/env bash
#
# demo-down.sh — stop the local demo services.
#
# Stops the engine (:3000) and frontend (:5173). Leaves the cloudflared tunnel
# running by default, so its URL survives and Butterbase stays wired for next
# time. Pass --tunnel to also kill the tunnel (its URL will change on restart).
#
#   ./scripts/demo-down.sh            # engine + frontend
#   ./scripts/demo-down.sh --tunnel   # also stop the tunnel

set -uo pipefail
cd "$(dirname "$0")/.."

if [ -t 1 ]; then G=$'\e[32m'; Y=$'\e[33m'; X=$'\e[0m'; else G=; Y=; X=; fi
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$1"; }

pkill -f "src/engine/server.js" >/dev/null 2>&1 && ok "stopped engine" || warn "engine not running"
pkill -f "vite --port=5173"     >/dev/null 2>&1 && ok "stopped frontend" || warn "frontend not running"

if [ "${1:-}" = "--tunnel" ]; then
  pkill -f "cloudflared tunnel --url http://localhost:3000" >/dev/null 2>&1 && ok "stopped tunnel (URL will change on restart)" || warn "tunnel not running"
else
  warn "tunnel left running (use --tunnel to stop it)"
fi
