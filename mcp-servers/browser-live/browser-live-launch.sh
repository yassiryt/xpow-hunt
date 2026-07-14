#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# ── macOS compatibility shims ────────────────────────────────────────
# The lifecycle logic below relies on util-linux `flock`/`setsid` and Linux
# /proc, none of which exist on stock macOS. Provide faithful python3-backed
# equivalents. These are only defined when the real tools are missing (so the
# script is unchanged on Linux), and are exported so the detached reaper
# (a fresh `bash -c`) inherits them too.
if ! command -v flock >/dev/null 2>&1; then
  # Emulates the `flock <fd>` form: exclusive, blocking lock on the open file
  # referenced by the inherited fd. The lock lives on the open-file-description,
  # so it persists after this child exits as long as the shell keeps <fd> open.
  flock() { python3 -c 'import fcntl,sys; fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX)' "$1"; }
  export -f flock
fi
if ! command -v setsid >/dev/null 2>&1; then
  # Runs argv in a new session (macOS lacks the util-linux CLI but has setsid(2)).
  setsid() { python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@"; }
  export -f setsid
fi

# ── Workspace isolation ──────────────────────────────────────────────
# Each workspace gets its own Chrome profile + unique port.
# Profile is stored inside the workspace at .browser-live/ so it
# persists across sessions and stays tied to that workspace.
#
# Multiple Claude sessions in different folders run independent Chromes.
# If Chrome is closed or crashes, it auto-restarts.
#
# Lifecycle (leak fix): Chrome runs in its OWN session/process group
# (setsid) and is reference-counted by live MCP "owners". A detached
# reaper (also setsid, so it survives the MCP bridge's process-group
# teardown) restarts Chrome while any owner is alive and tears down the
# WHOLE Chrome process group once the last owner exits. This prevents
# orphaned Chrome processes from surviving session shutdown.

WORKSPACE="${BROWSER_LIVE_WORKSPACE:-$PWD}"
HOST="${BROWSER_LIVE_HOST:-127.0.0.1}"
CHROME_BIN="${BROWSER_LIVE_CHROME_BIN:-/opt/google/chrome/chrome}"

# Derive a unique port per workspace (9300–9399) from path hash.
# Override with BROWSER_LIVE_PORT if needed.
WORKSPACE_HASH=$(echo -n "$WORKSPACE" | cksum | awk '{print $1}')
PORT="${BROWSER_LIVE_PORT:-$(( 9300 + WORKSPACE_HASH % 100 ))}"

# Per-workspace paths
PROFILE_DIR="$WORKSPACE/.browser-live/chrome-profile"
LOG_DIR="$WORKSPACE/.browser-live/logs"
LOCK_FILE="$WORKSPACE/.browser-live/chrome.lock"
PID_FILE="$WORKSPACE/.browser-live/chrome.pid"
MONITOR_PID_FILE="$WORKSPACE/.browser-live/monitor.pid"
OWNERS_DIR="$WORKSPACE/.browser-live/owners"
MCP_PID="$$"
DEBUG_URL="http://${HOST}:${PORT}/json/version"
MCP_ENTRYPOINT="${BROWSER_LIVE_MCP_ENTRYPOINT:-$SCRIPT_DIR/browser-live-mcp-entry.mjs}"
MCP_PROXY_ENTRYPOINT="${BROWSER_LIVE_MCP_PROXY_ENTRYPOINT:-$SCRIPT_DIR/browser-live-mcp-proxy.mjs}"
MCP_LOG_FILE="$LOG_DIR/chrome-devtools-mcp-${PORT}.log"
MCP_GUARD_LOG_FILE="$LOG_DIR/chrome-devtools-mcp-guard-${PORT}.log"
MCP_PROXY_LOG_FILE="$LOG_DIR/chrome-devtools-mcp-proxy-${PORT}.log"
MONITOR_LOG_FILE="$LOG_DIR/browser-live-monitor-${PORT}.log"
USE_MCP_PROXY="1"
ENABLE_PAGE_ID_ROUTING="${BROWSER_LIVE_ENABLE_PAGE_ID_ROUTING:-1}"
# Lower default tab cap + headless toggle for memory-constrained hosts.
MAX_TABS="${BROWSER_LIVE_MAX_TABS:-4}"
HEALTH_FAILURE_THRESHOLD="${BROWSER_LIVE_HEALTH_FAILURE_THRESHOLD:-3}"
CHROME_HEADLESS="${BROWSER_LIVE_HEADLESS:-0}"

mkdir -p "$PROFILE_DIR" "$LOG_DIR" "$OWNERS_DIR" "$(dirname "$LOCK_FILE")"

# Auto-add .browser-live to .gitignore if workspace is a git repo
if [[ -d "$WORKSPACE/.git" ]] && ! grep -qsF '.browser-live' "$WORKSPACE/.gitignore" 2>/dev/null; then
  echo '.browser-live/' >> "$WORKSPACE/.gitignore"
fi

if [[ ! -x "$CHROME_BIN" ]]; then
  echo "browser-live: chrome not found at $CHROME_BIN" >&2
  exit 1
fi

if [[ ! -f "$MCP_ENTRYPOINT" ]]; then
  echo "browser-live: MCP entrypoint not found at $MCP_ENTRYPOINT" >&2
  exit 1
fi

if [[ "$USE_MCP_PROXY" == "1" && ! -f "$MCP_PROXY_ENTRYPOINT" ]]; then
  echo "browser-live: MCP proxy entrypoint not found at $MCP_PROXY_ENTRYPOINT" >&2
  exit 1
fi

check_browser() {
  curl -fsS --max-time 2 "$DEBUG_URL" >/dev/null 2>&1
}

# Build Chrome's argument list once so initial start and monitor restart
# never drift apart.
build_chrome_args() {
  CHROME_ARGS=(
    --remote-debugging-address="$HOST"
    --remote-debugging-port="$PORT"
    --user-data-dir="$PROFILE_DIR"
    --no-first-run
    --no-default-browser-check
    --disable-background-networking
    --disable-sync
    --disable-translate
    --disable-extensions
    --disable-component-extensions-with-background-pages
    --disable-default-apps
    --disable-features=TranslateUI
    --disable-dev-shm-usage
    --lang=en-US
    --window-size=1440,900
  )
  if [[ "$CHROME_HEADLESS" == "1" ]]; then
    CHROME_ARGS+=(--headless=new)
  fi
  CHROME_ARGS+=(about:blank)
}

start_browser() {
  build_chrome_args
  # Launch Chrome as its OWN session/process group leader (setsid) so the
  # entire Chrome process tree (browser + zygote + GPU + renderers) can be
  # reaped later with a single process-group kill, and so Chrome never
  # shares a process group with the MCP bridge/script. The inner shell
  # records the real leader PID (== PGID) into PID_FILE before exec; exec
  # preserves that PID for Chrome. Lock fds (7/8/9) are closed so a
  # backgrounded Chrome can never hold an flock.
  setsid bash -c 'echo "$$" > "$1"; shift; exec "$@"' _ \
    "$PID_FILE" "$CHROME_BIN" "${CHROME_ARGS[@]}" \
    >"$LOG_DIR/chrome-${PORT}.log" 2>&1 7>&- 8>&- 9>&- < /dev/null &
}

chrome_alive() {
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# Count live MCP owners, pruning dead/foreign owner files. An owner is
# only "live" if its PID exists AND its cmdline still belongs to a
# browser-live MCP process (defends against PID reuse).
count_live_owners() {
  local n=0 f pid
  shopt -s nullglob
  for f in "$OWNERS_DIR"/*; do
    pid=$(basename "$f")
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null \
       && ps -p "$pid" -o command= 2>/dev/null | grep -qa 'browser-live'; then
      n=$((n + 1))
    else
      rm -f "$f"
    fi
  done
  shopt -u nullglob
  printf '%s' "$n"
}

register_owner() {
  mkdir -p "$OWNERS_DIR"
  : > "$OWNERS_DIR/$MCP_PID"
}

# Tear down the entire Chrome process group (TERM, then KILL after grace).
kill_chrome_group() {
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
}

kill_stale_chrome() {
  # Kill any Chrome using OUR port that isn't ours
  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      return 0  # Our Chrome is still alive
    fi
  fi
  # Check if something else grabbed our port
  if check_browser; then
    local port_pid
    port_pid=$(lsof -ti "tcp:$PORT" 2>/dev/null | head -1 || true)
    if [[ -n "$port_pid" ]]; then
      kill "$port_pid" 2>/dev/null || true
      sleep 0.5
    fi
  fi
}

wait_for_browser() {
  for _ in $(seq 1 75); do
    if check_browser; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

stop_existing_monitor() {
  if [[ ! -f "$MONITOR_PID_FILE" ]]; then
    return 0
  fi

  local old_monitor_pid
  old_monitor_pid=$(cat "$MONITOR_PID_FILE" 2>/dev/null || true)

  # Only signal it if it is actually one of our reapers (PID-reuse guard).
  if [[ -n "$old_monitor_pid" ]] && kill -0 "$old_monitor_pid" 2>/dev/null \
     && ps -p "$old_monitor_pid" -o command= 2>/dev/null | grep -qa 'browser-live'; then
    kill "$old_monitor_pid" 2>/dev/null || true

    for _ in $(seq 1 20); do
      if ! kill -0 "$old_monitor_pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
  fi

  rm -f "$MONITOR_PID_FILE"
}

# ── Health + lifecycle reaper ───────────────────────────────────────
# Runs detached in its own session. Restarts Chrome while any MCP owner
# is alive, trims excess tabs, and reaps the Chrome process group once no
# live owner remains.
chrome_monitor_loop() {
  echo "$BASHPID" > "$MONITOR_PID_FILE"
  trap '
    if [[ -f "'"$MONITOR_PID_FILE"'" ]] && [[ "$(cat "'"$MONITOR_PID_FILE"'" 2>/dev/null || true)" == "$BASHPID" ]]; then
      rm -f "'"$MONITOR_PID_FILE"'"
    fi
  ' EXIT

  local CONSECUTIVE_HEALTH_FAILURES=0

  while true; do
    sleep 5

    # 0. Lifecycle: once no live MCP owner remains, tear Chrome down and exit.
    if [[ "$(count_live_owners)" -eq 0 ]]; then
      echo "browser-live: no live MCP owners remain, tearing down Chrome on port $PORT" >&2
      kill_chrome_group
      exit 0
    fi

    # 1. Restart Chrome if it is consistently unreachable
    if ! check_browser; then
      CONSECUTIVE_HEALTH_FAILURES=$((CONSECUTIVE_HEALTH_FAILURES + 1))
      if (( CONSECUTIVE_HEALTH_FAILURES < HEALTH_FAILURE_THRESHOLD )); then
        echo "browser-live: Chrome probe failed (${CONSECUTIVE_HEALTH_FAILURES}/${HEALTH_FAILURE_THRESHOLD}), waiting before restart..." >&2
        continue
      fi

      echo "browser-live: Chrome unresponsive across ${CONSECUTIVE_HEALTH_FAILURES} probes, restarting..." >&2
      (
        flock 7
        if ! check_browser; then
          start_browser
          wait_for_browser || true
        fi
      ) 7>"$LOCK_FILE"
      CONSECUTIVE_HEALTH_FAILURES=0
      continue
    fi

    CONSECUTIVE_HEALTH_FAILURES=0

    # 2. Auto-close excess tabs to prevent OOM from subagent tab storms
    TAB_JSON=$(curl -fsS --max-time 2 "http://${HOST}:${PORT}/json" 2>/dev/null || true)
    if [[ -n "$TAB_JSON" ]]; then
      TAB_COUNT=$(echo "$TAB_JSON" | python3 -c "import sys,json; print(sum(1 for tab in json.load(sys.stdin) if tab.get('type') == 'page'))" 2>/dev/null || echo 0)
      if (( TAB_COUNT > MAX_TABS )); then
        echo "browser-live: $TAB_COUNT tabs open (max $MAX_TABS), closing excess..." >&2
        # Close all extra page tabs, but ignore non-page DevTools targets.
        echo "$TAB_JSON" | python3 -c "
import sys, json, urllib.request
tabs = [tab for tab in json.load(sys.stdin) if tab.get('type') == 'page']
blank_tabs = [t for t in tabs if t.get('url') == 'about:blank']
# Keep the first blank tab, close the rest
for tab in blank_tabs[1:]:
    tid = tab.get('id','')
    try:
        urllib.request.urlopen(f'http://${HOST}:${PORT}/json/close/{tid}', timeout=2)
        print(f'  closed: {tid}', file=sys.stderr)
    except: pass
# Also close any tabs that have been on the same URL for over 10 min (stale navigations)
for tab in tabs:
    if tab.get('url','').startswith('about:blank'):
        continue
    tid = tab.get('id','')
    # Close if we have too many non-blank tabs
    if len([t for t in tabs if not t.get('url','').startswith('about:blank')]) > $MAX_TABS:
        try:
            urllib.request.urlopen(f'http://${HOST}:${PORT}/json/close/{tid}', timeout=2)
            print(f'  closed stale: {tid} ({tab.get(\"url\",\"?\")[:60]})', file=sys.stderr)
        except: pass
        tabs.remove(tab)
" 2>&1
      fi
    fi
  done
}

# ── Startup with lock ────────────────────────────────────────────────
exec 9>"$LOCK_FILE"
flock 9

if ! check_browser; then
  kill_stale_chrome
  start_browser
  if ! wait_for_browser; then
    echo "browser-live: failed to start Chrome on port $PORT for workspace $WORKSPACE" >&2
    exec 9>&-
    exit 1
  fi
fi

# Register this MCP server as a live owner BEFORE the reaper starts so the
# reaper never tears Chrome down while we are still attaching.
register_owner

printf '%s browser-live-launch: Chrome ready on port %s, profile at %s\n' \
  "$(date +%Y-%m-%dT%H:%M:%S%z)" "$PORT" "$PROFILE_DIR" >> "$MONITOR_LOG_FILE"

exec 9>&-

# ── Spawn detached reaper ───────────────────────────────────────────
exec 8>"$LOCK_FILE"
flock 8
stop_existing_monitor

# Export everything the detached reaper needs, then launch it in its OWN
# session (setsid) so kiro-cli killing the MCP bridge's process group can
# never take the reaper down — guaranteeing Chrome is always reaped.
export HOST PORT PROFILE_DIR LOG_DIR LOCK_FILE PID_FILE MONITOR_PID_FILE \
  OWNERS_DIR DEBUG_URL CHROME_BIN MAX_TABS HEALTH_FAILURE_THRESHOLD CHROME_HEADLESS
export -f check_browser build_chrome_args start_browser chrome_alive \
  count_live_owners kill_chrome_group wait_for_browser chrome_monitor_loop

setsid bash -c 'chrome_monitor_loop' >>"$MONITOR_LOG_FILE" 2>&1 7>&- 8>&- 9>&- < /dev/null &
exec 8>&-

# ── Launch MCP bridge ────────────────────────────────────────────────
MCP_SERVER_ARGS=(
  "$MCP_ENTRYPOINT"
  "--browser-url=$DEBUG_URL"
  "--no-usage-statistics"
  "--logFile=$MCP_LOG_FILE"
)

if [[ "$ENABLE_PAGE_ID_ROUTING" == "1" ]]; then
  MCP_SERVER_ARGS+=("--experimental-page-id-routing")
fi

if [[ "$USE_MCP_PROXY" == "1" ]]; then
  exec env \
    BROWSER_LIVE_MCP_PATCH_LOG_FILE="$MCP_GUARD_LOG_FILE" \
    BROWSER_LIVE_MCP_PROXY_LOG_FILE="$MCP_PROXY_LOG_FILE" \
    BROWSER_LIVE_MCP_PROXY_LOG_RAW_HOST_REQUESTS="${BROWSER_LIVE_MCP_PROXY_LOG_RAW_HOST_REQUESTS:-0}" \
    BROWSER_LIVE_WORKSPACE_PATH="$WORKSPACE" \
    bash -lc 'cat | node "$@"' _ \
    "$MCP_PROXY_ENTRYPOINT" -- \
    node "${MCP_SERVER_ARGS[@]}"
fi

exec env \
  BROWSER_LIVE_MCP_PATCH_LOG_FILE="$MCP_GUARD_LOG_FILE" \
  bash -lc 'cat | node "$@"' _ \
  "${MCP_SERVER_ARGS[@]}"
