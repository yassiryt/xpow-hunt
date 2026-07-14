#!/usr/bin/env bash
# =============================================================================
# xpow-hunt restore/install  —  macOS adaptation
# Faithful port of install.sh for macOS (Darwin). Differences vs. the Linux
# original, and ONLY these:
#   * portable in-place edit (BSD sed needs `-i ''`)  -> sedi() helper
#   * gateway auto-start via launchd LaunchAgent       (systemd unavailable)
#   * native `fd` (the bundled pi-agent/bin/fd is a Linux ELF, can't run here)
# Everything else (npm -g pi, rsync of configs, venv, token wiring) is identical.
#
# Usage:   ./install-macos.sh                 # full install
#          GITHUB_MCP_TOKEN=ghp_xxx ./install-macos.sh
#          ./install-macos.sh --dry-run       # print actions, change nothing
#
# Safe to re-run: existing targets are backed up to <path>.bak-<timestamp>.
# =============================================================================
set -uo pipefail

SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
H="$HOME"
OLD_HOME="__XPOW_HOME__"                     # portable template marker, resolved to $HOME
USER_NAME="$(id -un)"
UID_NUM="$(id -u)"
TS="$(date +%Y%m%d-%H%M%S)"
PI_PKG="@earendil-works/pi-coding-agent@0.79.0"
GW_PORT="${KIRO_GW_PORT:-8790}"
GW_LABEL="com.xpowhunt.kiro-gateway"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
DRYLBL=""; [ "$DRY" = 1 ] && DRYLBL=" (dry-run — nothing changed)"

c(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok(){ printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[1;33m! %s\033[0m\n' "$*"; }
run(){ if [ "$DRY" = 1 ]; then printf '   [dry] %s\n' "$*"; else eval "$@"; fi; }
# portable in-place sed: GNU accepts `-i`, BSD/macOS needs `-i ''`
sedi(){ if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
bk(){ [ -e "$1" ] && { if [ "$DRY" = 1 ]; then printf '   [dry] backup %s\n' "$1"; else cp -a "$1" "$1.bak-$TS" && ok "backed up existing $(basename "$1") -> .bak-$TS"; fi; }; }
rehome(){ [ "$DRY" = 1 ] && { printf '   [dry] rehome %s\n' "$1"; return; }; [ -f "$1" ] && grep -Iq "$OLD_HOME" "$1" 2>/dev/null && sedi "s|$OLD_HOME|$H|g" "$1" && ok "re-homed $(basename "$1")"; }
npmdeps(){ # npm ci (fallback install) in dir $1
  [ "$DRY" = 1 ] && { printf '   [dry] npm ci in %s\n' "$1"; return; }
  ( cd "$1" && { npm ci --silent 2>/dev/null || npm install --silent; } ) && ok "deps installed: $(basename "$1")" || warn "npm install failed in $1 (run it manually)"; }

c "Prerequisites  (macOS $(sw_vers -productVersion 2>/dev/null) $(uname -m))"
[ "$(uname -s)" = "Darwin" ] || warn "this script is the macOS port but uname is $(uname -s); the Linux install.sh may suit you better."
miss=0
for t in node npm python3 curl rsync; do command -v "$t" >/dev/null || { warn "MISSING (required): $t"; miss=1; }; done
[ "$miss" = 1 ] && { echo "Install the missing required tools and re-run."; exit 1; }
echo "   node $(node -v) | npm $(npm -v) | $(python3 -V) | $USER_NAME@$(hostname)"
NODE_MAJ="$(node -v | sed 's/v\([0-9]*\).*/\1/')"; [ "$NODE_MAJ" -lt 22 ] 2>/dev/null && warn "node < 22 — pi 0.79.0 expects Node 22+."
command -v kiro-cli >/dev/null && ok "kiro-cli present (auth source)" || warn "kiro-cli NOT found — install it + 'kiro-cli login' (the gateway follows its live token)."
command -v java >/dev/null && ok "java present (burp MCP)" || warn "java NOT found — needed for the burp MCP proxy jar."
{ command -v chromium >/dev/null || command -v "Google Chrome" >/dev/null || [ -d "/Applications/Google Chrome.app" ] || [ -d "/Applications/Chromium.app" ]; } && ok "chrome/chromium present (browser-live)" || warn "chromium/Chrome NOT found — browser-live needs it (install, or set BROWSER_LIVE_CHROME_BIN)."

c "1/9  pi runtime  ($PI_PKG)"
if [ "$(pi --version 2>/dev/null)" = "0.79.0" ]; then ok "pi 0.79.0 already installed"; else
  run "npm install -g '$PI_PKG'" && ok "installed pi" || warn "npm -g install failed (check 'npm prefix -g' / PATH)"; fi

c "2/9  pi agent config  ->  $H/.pi/agent"
run "mkdir -p '$H/.pi/agent'"; bk "$H/.pi/agent"
run "rsync -a '$SRC/pi-agent/' '$H/.pi/agent/'" && ok "24 agents, extensions (mcp-bridge, subagent ensemble/swarm + MCP profiles, auto-continue), models.json, settings.json, prompts, adapter"
[ "$DRY" = 0 ] && grep -Ilr "$OLD_HOME" "$H/.pi/agent" 2>/dev/null | while read -r f; do sedi "s|$OLD_HOME|$H|g" "$f"; done
[ -f "$H/.pi/agent/extensions/mcp-bridge/package.json" ] && npmdeps "$H/.pi/agent/extensions/mcp-bridge"
# fd: the bundled pi-agent/bin/fd is a Linux ELF and cannot execute on macOS.
# Replace it with a native fd (Homebrew), symlinked so both the absolute path
# and PATH lookups resolve. Non-fatal: fd is a runtime convenience, not required
# for gateway/pi verification.
if [ "$DRY" = 1 ]; then printf '   [dry] replace Linux fd with native fd (brew if needed)\n'; else
  FDBIN="$(command -v fd 2>/dev/null || true)"
  if [ -z "$FDBIN" ] && command -v brew >/dev/null 2>&1; then
    warn "installing native fd via brew (bundled fd is Linux-only)…"; brew install fd >/dev/null 2>&1 || true
    FDBIN="$(command -v fd 2>/dev/null || echo "$(brew --prefix 2>/dev/null)/bin/fd")"
  fi
  if [ -n "${FDBIN:-}" ] && [ -x "$FDBIN" ]; then ln -sf "$FDBIN" "$H/.pi/agent/bin/fd" && ok "fd -> native $FDBIN (replaced Linux ELF)"; \
    else warn "no native fd — install it then: ln -sf \$(command -v fd) $H/.pi/agent/bin/fd"; fi
fi

c "3/9  MCP config  ->  $H/.kiro/settings/mcp.json  (+ github token)"
run "mkdir -p '$H/.kiro/settings'"
PRIOR_TOK="$(grep -o 'ghp_[A-Za-z0-9]*' "$H/.kiro/settings/mcp.json" 2>/dev/null | head -1)"   # preserve on re-install
bk "$H/.kiro/settings/mcp.json"
run "cp -p '$SRC/kiro-settings/mcp.json' '$H/.kiro/settings/mcp.json'"
rehome "$H/.kiro/settings/mcp.json"
TOK="${GITHUB_MCP_TOKEN:-$PRIOR_TOK}"
if [ -z "$TOK" ] && [ "$DRY" = 0 ] && [ -t 0 ]; then read -rsp '   GitHub MCP token (ghp_… ; Enter to skip): ' TOK; echo; fi
if [ -n "$TOK" ] && [ "$DRY" = 0 ]; then sedi "s|\${GITHUB_MCP_TOKEN}|$TOK|g" "$H/.kiro/settings/mcp.json"; ok "github MCP token wired"; \
  else warn "github token not set — edit \${GITHUB_MCP_TOKEN} in mcp.json, or re-run with GITHUB_MCP_TOKEN=ghp_…"; fi
ok "mcp.json placed (browser-live, burp, memory, github, medium, gmail)"
# macOS: browser-live ships the Linux /usr/bin/chromium; point it at the real Chrome.
if [ "$DRY" = 0 ]; then
  CHROME_MAC="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [ -x "$CHROME_MAC" ] && grep -q '/usr/bin/chromium' "$H/.kiro/settings/mcp.json" 2>/dev/null; then
    sedi "s|/usr/bin/chromium|$CHROME_MAC|g" "$H/.kiro/settings/mcp.json"; ok "browser-live -> macOS Chrome"
  else grep -q '/usr/bin/chromium' "$H/.kiro/settings/mcp.json" 2>/dev/null && warn "browser-live: set BROWSER_LIVE_CHROME_BIN to your Chrome (no /Applications/Google Chrome.app found)."; fi
else printf '   [dry] point browser-live BROWSER_LIVE_CHROME_BIN at macOS Chrome\n'; fi

c "4/9  MCP server implementations"
# browser-live -> ~/.claude/mcp
run "mkdir -p '$H/.claude/mcp'"
run "rsync -a '$SRC/mcp-servers/browser-live/' '$H/.claude/mcp/'"
[ "$DRY" = 0 ] && chmod +x "$H/.claude/mcp/"*.sh 2>/dev/null
rehome "$H/.claude/mcp/browser-live-launch.sh"
npmdeps "$H/.claude/mcp"
# chrome-devtools-mcp -> ~/.local/share/browser-live/chrome-devtools-mcp (npm ci pulls the 18M dep)
CDT="$H/.local/share/browser-live/chrome-devtools-mcp"
run "mkdir -p '$CDT'"
run "cp -p '$SRC/mcp-servers/chrome-devtools-mcp/'package*.json '$CDT/'"
npmdeps "$CDT"
# medium-rss-mcp -> ~/opencode/medium-rss-mcp
run "mkdir -p '$H/opencode/medium-rss-mcp'"
run "cp -p '$SRC/mcp-servers/medium-rss-mcp/server.mjs' '$H/opencode/medium-rss-mcp/'" && ok "medium-rss-mcp (no deps)"
# burp proxy jar -> ~/.BurpSuite/mcp-proxy
run "mkdir -p '$H/.BurpSuite/mcp-proxy'"
run "cp -p '$SRC/mcp-servers/burp-mcp-proxy/mcp-proxy-all.jar' '$H/.BurpSuite/mcp-proxy/'" && ok "burp mcp-proxy jar (needs Burp app + AI-Agent ext on :9876)"
# memory data -> ~/.config/opencode/memory (don't clobber an existing graph)
run "mkdir -p '$H/.config/opencode/memory'"
if [ "$DRY" = 0 ] && [ -f "$SRC/data/memory.jsonl" ] && [ ! -f "$H/.config/opencode/memory/memory.jsonl" ]; then
  cp -p "$SRC/data/memory.jsonl" "$H/.config/opencode/memory/" && ok "seeded memory.jsonl (hunt memory)"
else warn "kept existing memory.jsonl (bundled copy at data/memory.jsonl to merge if wanted)"; fi
warn "gmail MCP: put your OAuth files at $H/.gmail-mcp/{gcp-oauth.keys.json,credentials.json} then auth (npx @gongrzhe/server-gmail-autoauth-mcp auth). NOT bundled (secrets)."

c "5/9  steering + skills + coordinator prompt"
run "mkdir -p '$H/.kiro/steering' '$H/.kiro/skills' '$H/.config/opencode/prompts/claude-agents'"
run "cp -p '$SRC'/steering/*.md '$H/.kiro/steering/'" && ok "steering"
run "rsync -a '$SRC/skills/' '$H/.kiro/skills/'" && ok "skills (×31)"
run "cp -p '$SRC/prompts/build.md' '$H/.config/opencode/prompts/claude-agents/build.md'" && ok "coordinator brain (build.md)"

c "6/9  kiro-gateway  ->  $H/tools/kiro-gateway  (+ venv)"
GW="$H/tools/kiro-gateway"; run "mkdir -p '$H/tools'"; bk "$GW"
run "rsync -a '$SRC/kiro-gateway/' '$GW/'" && ok "gateway + local fixes (tokenizer, retries/heartbeat, auth-merge, faulthandler)"
[ "$DRY" = 0 ] && [ ! -f "$GW/.env" ] && [ -f "$GW/.env.example" ] && cp "$GW/.env.example" "$GW/.env"
rehome "$GW/.env"
[ "$DRY" = 0 ] && grep -q '^DEBUG_MODE=' "$GW/.env" 2>/dev/null && { sedi 's/^DEBUG_MODE=.*/DEBUG_MODE="off"/' "$GW/.env"; ok "DEBUG_MODE=off (was 'all' for debugging)"; }
# macOS: kiro-cli stores its token DB under ~/Library/Application Support, not the
# Linux XDG ~/.local/share. Re-point KIRO_CLI_DB_FILE so KIRO_FOLLOW_CLI resolves it.
if [ "$DRY" = 0 ]; then
  sedi 's|/.local/share/kiro-cli|/Library/Application Support/kiro-cli|g' "$GW/.env"
  KDB="$H/Library/Application Support/kiro-cli/data.sqlite3"
  [ -f "$KDB" ] && ok "KIRO_CLI_DB_FILE -> macOS kiro-cli store (token DB found)" || warn "KIRO_CLI_DB_FILE pointed at macOS store, but no DB yet — run 'kiro-cli login'."
else printf '   [dry] re-point KIRO_CLI_DB_FILE to macOS kiro-cli store\n'; fi
run "python3 -m venv '$GW/.venv'"
run "'$GW/.venv/bin/pip' install -q --upgrade pip"
run "'$GW/.venv/bin/pip' install -q -r '$GW/requirements.txt'" && ok "gateway venv built" || warn "venv deps failed — check wheels for $(python3 -V) (tiktoken/uvicorn). See note at end."

c "7/9  launchers  ->  $H/.local/bin"
run "mkdir -p '$H/.local/bin'"
for l in xpow-hunt xpow-gateway xpow-model; do [ -f "$SRC/bin/$l" ] || continue; bk "$H/.local/bin/$l"; run "cp -p '$SRC/bin/$l' '$H/.local/bin/$l'"; rehome "$H/.local/bin/$l"; run "chmod +x '$H/.local/bin/$l'"; done
ok "xpow-hunt, xpow-gateway, xpow-model (model toggle)"
case ":$PATH:" in *":$H/.local/bin:"*) :;; *) warn "$H/.local/bin not on PATH — add: export PATH=\"\$HOME/.local/bin:\$PATH\"";; esac

c "8/9  launchd user agent (gateway auto-start + self-heal)  [macOS analog of systemd unit]"
PLIST="$H/Library/LaunchAgents/$GW_LABEL.plist"
run "mkdir -p '$H/Library/LaunchAgents'"
if [ "$DRY" = 1 ]; then printf '   [dry] write %s and launchctl load it\n' "$PLIST"; else
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$GW_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$GW/.venv/bin/python</string>
        <string>main.py</string>
        <string>--port</string>
        <string>$GW_PORT</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$GW</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONFAULTHANDLER</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>2</integer>
    <key>StandardOutPath</key>
    <string>$GW/gw.log</string>
    <key>StandardErrorPath</key>
    <string>$GW/gw.log</string>
</dict>
</plist>
PLIST_EOF
  ok "wrote LaunchAgent $PLIST (RunAtLoad + KeepAlive = systemd 'enable --now' + 'Restart=always')"
  launchctl unload "$PLIST" 2>/dev/null || true
  if launchctl load -w "$PLIST" 2>/dev/null; then ok "gateway service loaded + started"; else warn "launchctl load failed — start manually: cd $GW && ./.venv/bin/python main.py --port $GW_PORT"; fi
fi

c "9/9  verify"
if [ "$DRY" = 0 ]; then sleep 4; HC="$(curl -s -m4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GW_PORT/health" 2>/dev/null)"; \
  [ "$HC" = "200" ] && ok "gateway healthy on :$GW_PORT" || warn "gateway health=${HC:-none} (logs: $GW/gw.log ; launchctl list | grep $GW_LABEL)"; fi
# Offline self-test of the force-multiplier logic (ensemble/swarm builders, MCP
# profiles, RAM gate, depth cap, retry classification). No model calls.
ST="$H/.pi/agent/extensions/subagent/selftest.mjs"
if [ "$DRY" = 0 ] && [ -f "$ST" ]; then
  ( cd "$H/.pi/agent/extensions/subagent" && node --experimental-strip-types ./selftest.mjs >/tmp/xpowhunt-selftest.log 2>&1 ) \
    && ok "subagent self-test passed (ensemble/swarm/profiles/RAM/depth/retry)" \
    || warn "subagent self-test FAILED — see /tmp/xpowhunt-selftest.log"
else [ "$DRY" = 1 ] && printf '   [dry] run subagent selftest.mjs\n'; fi
# Offline self-test of the deterministic scope engine (scope_build/scope_check). No model/network.
SC="$H/.pi/agent/bin/scope_selftest.sh"
if [ "$DRY" = 0 ] && [ -f "$SC" ]; then
  chmod +x "$H/.pi/agent/bin/"scope_*.sh 2>/dev/null
  ( "$SC" >/tmp/xpowhunt-scope-selftest.log 2>&1 ) \
    && ok "scope engine self-test passed (build + IN/OOS/UNLISTED/PATH_RESTRICTED gate)" \
    || warn "scope engine self-test FAILED — see /tmp/xpowhunt-scope-selftest.log"
else [ "$DRY" = 1 ] && printf '   [dry] run scope_selftest.sh\n'; fi
AGENTS_N="$(ls "$H/.pi/agent/agents/"*.md 2>/dev/null | wc -l | tr -d ' ')"
[ "$DRY" = 0 ] && ok "$AGENTS_N specialist agents installed"

cat <<EOF

-----------------------------------------------------------------------------
 xpow-hunt restore complete${DRYLBL}  [macOS].

 STILL MACHINE-SPECIFIC (can't be copied):
   1. kiro-cli login                         # gateway's auth source
   2. GitHub MCP token                       # GITHUB_MCP_TOKEN=ghp_… ./install-macos.sh  (or edit mcp.json)
   3. Gmail MCP OAuth                         # $H/.gmail-mcp/{gcp-oauth.keys.json,credentials.json} + auth
   4. Burp Suite app + AI-Agent extension     # the bundled jar bridges to Burp on 127.0.0.1:9876

 SERVICE (macOS): launchctl list | grep $GW_LABEL   ·   logs: $GW/gw.log
   stop/start:  launchctl unload/load -w $H/Library/LaunchAgents/$GW_LABEL.plist
 NOTE: gateway venv uses $(python3 -V 2>/dev/null). If tiktoken/uvicorn wheels
       were missing, install an LTS python (e.g. brew install python@3.12) and
       rebuild: python3.12 -m venv $GW/.venv && … pip install -r requirements.txt

 RUN:
   xpow-hunt                                    # then: Hunt <program> for CRITICAL
-----------------------------------------------------------------------------
EOF
