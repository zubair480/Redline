#!/usr/bin/env bash
#
# demo-up.sh — bring the Redline demo up fresh.
#
# Restarts the engine (:3000) and frontend (:5173) cleanly, REUSES the running
# cloudflared tunnel so its URL never changes (Butterbase stays wired), then
# pre-warms the RocketRide LLM cache so every demo scan is sub-second.
#
# It never restarts the tunnel. If no tunnel is running it starts one and warns
# loudly, because a new quick-tunnel URL means Butterbase env vars must be
# re-pointed before scans work.
#
#   ./scripts/demo-up.sh        (or: npm run demo)
#
# Stop the local services later with: npm run demo:down

set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ---- config ----
ENGINE_PORT=3000
FRONTEND_PORT=5173
LOG_DIR="$ROOT/logs"
STATE_FILE="$ROOT/.demo-tunnel-url"
# The tunnel URL Butterbase's SCAN_URL / ROCKETRIDE_* are currently pinned to.
# Override by exporting TUNNEL_URL or by having .demo-tunnel-url on disk.
DEFAULT_TUNNEL_URL="https://purse-surgeons-bell-appearance.trycloudflare.com"

mkdir -p "$LOG_DIR"

# ---- pretty output ----
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; X=$'\e[0m'; else B=; G=; Y=; R=; D=; X=; fi
step() { printf '\n%s==>%s %s\n' "$B" "$X" "$1"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$1"; }
die()  { printf '  %s✗%s %s\n' "$R" "$X" "$1"; exit 1; }

# Poll a URL until it returns HTTP 200, or time out.
wait_http() {
  local url="$1" name="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    if curl -s -o /dev/null -m 3 "$url"; then ok "$name is up ($url)"; return 0; fi
    sleep 0.5
  done
  return 1
}

printf '%s Redline demo — fresh start %s\n' "$B" "$X"

# ---- 1. stop existing engine + frontend (leave the tunnel alone) ----
step "Stopping old engine + frontend (tunnel is left running)"
pkill -f "src/engine/server.js"      >/dev/null 2>&1 && ok "stopped engine" || warn "no engine was running"
pkill -f "vite --port=$FRONTEND_PORT" >/dev/null 2>&1 && ok "stopped frontend" || warn "no frontend was running"
sleep 1

# ---- 2. tunnel: reuse if running, else start + warn ----
step "Tunnel (cloudflared -> localhost:$ENGINE_PORT)"
TUNNEL_URL="${TUNNEL_URL:-}"
[ -z "$TUNNEL_URL" ] && [ -f "$STATE_FILE" ] && TUNNEL_URL="$(cat "$STATE_FILE")"
[ -z "$TUNNEL_URL" ] && TUNNEL_URL="$DEFAULT_TUNNEL_URL"

# A cloudflared process can linger after its quick-tunnel URL has expired, so
# don't trust the process alone — verify the URL actually answers.
tunnel_alive() { [ -n "$TUNNEL_URL" ] && curl -s -o /dev/null -m 8 "$TUNNEL_URL/health"; }

if pgrep -f "cloudflared tunnel --url http://localhost:$ENGINE_PORT" >/dev/null 2>&1 && tunnel_alive; then
  ok "reusing running tunnel — URL unchanged, Butterbase wiring intact"
  printf '     %s%s%s\n' "$D" "$TUNNEL_URL" "$X"
else
  if pgrep -f "cloudflared tunnel --url http://localhost:$ENGINE_PORT" >/dev/null 2>&1; then
    warn "a cloudflared process is running but its URL is dead — replacing it"
    pkill -f "cloudflared tunnel --url http://localhost:$ENGINE_PORT" >/dev/null 2>&1
    sleep 1
  fi
  warn "starting a fresh tunnel (its URL will be NEW — Butterbase must be re-pointed)"
  if ! command -v cloudflared >/dev/null 2>&1; then
    die "cloudflared not installed. Start your tunnel manually, then re-run."
  fi
  nohup cloudflared tunnel --url "http://localhost:$ENGINE_PORT" >"$LOG_DIR/tunnel.log" 2>&1 &
  # cloudflared prints the assigned URL to its log within a few seconds.
  NEW_URL=""
  for _ in $(seq 1 30); do
    NEW_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_DIR/tunnel.log" 2>/dev/null | head -1)"
    [ -n "$NEW_URL" ] && break
    sleep 1
  done
  if [ -n "$NEW_URL" ]; then
    TUNNEL_URL="$NEW_URL"
    printf '%s' "$TUNNEL_URL" >"$STATE_FILE"
    ok "tunnel up: $TUNNEL_URL"
    printf '\n%s  ⚠ Butterbase env vars must be re-pointed to this new URL before scans work:%s\n' "$Y" "$X"
    printf '     ROCKETRIDE_CLASSIFY_URL = %s/classify\n' "$TUNNEL_URL"
    printf '     ROCKETRIDE_EXPLAIN_URL  = %s/explain\n' "$TUNNEL_URL"
    printf '     SCAN_URL                = %s/scan\n' "$TUNNEL_URL"
    printf '     %s(set on both the scan and apply-fix functions of app_wiexpf4uwdww)%s\n' "$D" "$X"
  else
    warn "could not read the tunnel URL from $LOG_DIR/tunnel.log — check it manually"
  fi
fi

# ---- 3. engine ----
step "Starting engine on :$ENGINE_PORT"
nohup npm start >"$LOG_DIR/engine.log" 2>&1 &
wait_http "http://localhost:$ENGINE_PORT/health" "engine" || die "engine did not become healthy — see $LOG_DIR/engine.log"

# ---- 4. frontend ----
step "Starting frontend on :$FRONTEND_PORT"
( cd "$ROOT/frontend" && exec npm run dev ) >"$LOG_DIR/frontend.log" 2>&1 &
wait_http "http://localhost:$FRONTEND_PORT/" "frontend" || die "frontend did not come up — see $LOG_DIR/frontend.log"

# ---- 5. pre-warm the LLM cache ----
step "Pre-warming RocketRide cache (so demo scans are instant)"
if npm run --silent prewarm; then ok "cache warm"; else warn "prewarm reported an issue — scans still work, first one is slow"; fi

# ---- 6. verify the public chain ----
step "Verifying the tunnel reaches the engine"
if curl -s -o /dev/null -m 8 "$TUNNEL_URL/health"; then ok "tunnel -> engine reachable"; else warn "tunnel/health failed ($TUNNEL_URL) — Butterbase scans may 5xx"; fi

# ---- summary ----
printf '\n%s────────────────────────────────────────────%s\n' "$B" "$X"
printf '%s Demo is up.%s\n' "$G" "$X"
printf '   Frontend : http://localhost:%s\n' "$FRONTEND_PORT"
printf '   Engine   : http://localhost:%s/health\n' "$ENGINE_PORT"
printf '   Tunnel   : %s\n' "$TUNNEL_URL"
printf '   Logs     : %s/{engine,frontend,tunnel}.log\n' "$LOG_DIR"
printf '%s────────────────────────────────────────────%s\n' "$B" "$X"
printf ' %sBefore presenting:%s open the frontend in an %sincognito window%s (or clear\n' "$B" "$X" "$B" "$X"
printf ' localStorage) so you start as a clean demo user with empty history.\n'
printf ' Stop the local services with: %snpm run demo:down%s\n\n' "$B" "$X"
