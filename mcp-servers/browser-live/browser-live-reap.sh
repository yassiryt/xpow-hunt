#!/usr/bin/env bash
# browser-live-reap.sh — reap orphaned browser-live Chrome process groups and
# clean stale state across all workspaces. Safe: a Chrome is only killed when
# it has NO live MCP owner AND NO live MCP bridge referencing its port.
#
# Usage:
#   browser-live-reap.sh            # dry-run: report only
#   browser-live-reap.sh --apply    # actually reap + clean
set -uo pipefail

ROOT="${BROWSER_LIVE_SCAN_ROOT:-$HOME}"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

port_for() { echo $(( 9300 + $(echo -n "$1" | cksum | awk '{print $1}') % 100 )); }

owner_live() {
  local d="$1" f pid
  shopt -s nullglob
  for f in "$d/owners"/*; do
    pid=$(basename "$f")
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null \
       && grep -qsa 'browser-live' "/proc/$pid/cmdline" 2>/dev/null; then
      shopt -u nullglob; return 0
    fi
  done
  shopt -u nullglob; return 1
}

bridge_live() {  # live MCP bridge referencing this port?
  local port="$1" pid
  for pid in $(pgrep -f 'browser-live-mcp' 2>/dev/null); do
    grep -qsa -- "$port" "/proc/$pid/cmdline" 2>/dev/null && return 0
  done
  return 1
}

kill_group() {
  local pid="$1"
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$pid" 2>/dev/null && { kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
}

reaped=0 cleaned=0 skipped=0
while IFS= read -r d; do
  ws=$(dirname "$d"); port=$(port_for "$ws")
  pid=$(cat "$d/chrome.pid" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    if owner_live "$d" || bridge_live "$port"; then
      echo "IN-USE   port $port  pid $pid  $ws"; skipped=$((skipped+1)); continue
    fi
    echo "ORPHAN   port $port  pid $pid  $ws  -> reap group"
    if (( APPLY )); then kill_group "$pid"; rm -f "$d/chrome.pid" "$d/monitor.pid"; fi
    reaped=$((reaped+1))
  else
    [[ -f "$d/chrome.pid" || -f "$d/monitor.pid" ]] && {
      echo "STALE    port $port  $ws  -> clean pid files"
      (( APPLY )) && rm -f "$d/chrome.pid" "$d/monitor.pid"
      cleaned=$((cleaned+1))
    }
  fi
done < <(find "$ROOT" -maxdepth 4 -type d -name .browser-live 2>/dev/null)

echo "---"
echo "reaped=$reaped cleaned=$cleaned in-use=$skipped  $([[ $APPLY -eq 0 ]] && echo '(dry-run; pass --apply to act)')"
