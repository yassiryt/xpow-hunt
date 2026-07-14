#!/usr/bin/env bash
# =============================================================================
# xpow-hunt restore/install
# Reinstalls the xpow-hunt bug-bounty setup exactly as on the source machine:
#   pi.dev coordinator + 23 specialist subagents (incl. hypothesis-redteam)
#   kiro-gateway (Anthropic<->Kiro bridge, with local fixes)
#   ALL 6 MCP servers (browser-live, burp, memory, github, medium, gmail)
#   steering, skills, coordinator prompt, systemd auto-start
#
# Usage:   ./install.sh                 # full install
#          GITHUB_MCP_TOKEN=ghp_xxx ./install.sh   # also wire the github MCP token
#          ./install.sh --dry-run       # print actions, change nothing
#
# Safe to re-run: existing targets are backed up to <path>.bak-<timestamp>.
# =============================================================================
set -uo pipefail

SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
H="$HOME"
OLD_HOME="__XPOW_HOME__"                     # portable template marker, resolved to $HOME
USER_NAME="$(id -un)"
TS="$(date +%Y%m%d-%H%M%S)"
PI_PKG="@earendil-works/pi-coding-agent@0.79.0"
GW_PORT="${KIRO_GW_PORT:-8790}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

c(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok(){ printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[1;33m! %s\033[0m\n' "$*"; }
run(){ if [ "$DRY" = 1 ]; then printf '   [dry] %s\n' "$*"; else eval "$@"; fi; }
bk(){ [ -e "$1" ] && { if [ "$DRY" = 1 ]; then printf '   [dry] backup %s\n' "$1"; else cp -a "$1" "$1.bak-$TS" && ok "backed up existing $(basename "$1") -> .bak-$TS"; fi; }; }
rehome(){ [ "$DRY" = 1 ] && { printf '   [dry] rehome %s\n' "$1"; return; }; [ -f "$1" ] && grep -Iq "$OLD_HOME" "$1" 2>/dev/null && sed -i "s|$OLD_HOME|$H|g" "$1" && ok "re-homed $(basename "$1")"; }
npmdeps(){ # npm ci (fallback install) in dir $1
  [ "$DRY" = 1 ] && { printf '   [dry] npm ci in %s\n' "$1"; return; }
  ( cd "$1" && { npm ci --silent 2>/dev/null || npm install --silent; } ) && ok "deps installed: $(basename "$1")" || warn "npm install failed in $1 (run it manually)"; }

c "Prerequisites"
miss=0
for t in node npm python3 curl rsync; do command -v "$t" >/dev/null || { warn "MISSING (required): $t"; miss=1; }; done
[ "$miss" = 1 ] && { echo "Install the missing required tools and re-run."; exit 1; }
echo "   node $(node -v) | npm $(npm -v) | $(python3 -V) | $USER_NAME@$(hostname)"
NODE_MAJ="$(node -v | sed 's/v\([0-9]*\).*/\1/')"; [ "$NODE_MAJ" -lt 22 ] 2>/dev/null && warn "node < 22 — pi 0.79.0 expects Node 22+."
command -v kiro-cli >/dev/null && ok "kiro-cli present (auth source)" || warn "kiro-cli NOT found — install it + 'kiro-cli login' (the gateway follows its live token)."
command -v java >/dev/null && ok "java present (burp MCP)" || warn "java NOT found — needed for the burp MCP proxy jar."
{ command -v chromium >/dev/null || [ -x /usr/bin/chromium ] || command -v google-chrome >/dev/null; } && ok "chromium present (browser-live)" || warn "chromium NOT found — browser-live needs /usr/bin/chromium (or set BROWSER_LIVE_CHROME_BIN)."

c "1/9  pi runtime  ($PI_PKG)"
if [ "$(pi --version 2>/dev/null)" = "0.79.0" ]; then ok "pi 0.79.0 already installed"; else
  run "npm install -g '$PI_PKG'" && ok "installed pi" || warn "npm -g install failed (check 'npm prefix -g' / PATH)"; fi

c "2/9  pi agent config  ->  $H/.pi/agent"
run "mkdir -p '$H/.pi/agent'"; bk "$H/.pi/agent"
run "rsync -a '$SRC/pi-agent/' '$H/.pi/agent/'" && ok "23 agents, extensions (mcp-bridge, subagent ensemble/swarm + MCP profiles, auto-continue), models.json, settings.json, prompts, adapter"
[ "$DRY" = 0 ] && grep -Ilr "$OLD_HOME" "$H/.pi/agent" 2>/dev/null | while read -r f; do sed -i "s|$OLD_HOME|$H|g" "$f"; done
[ -f "$H/.pi/agent/extensions/mcp-bridge/package.json" ] && npmdeps "$H/.pi/agent/extensions/mcp-bridge"
[ -f "$H/.pi/agent/bin/fd" ] && chmod +x "$H/.pi/agent/bin/fd" 2>/dev/null
[ "$(uname -m)" != "x86_64" ] && warn "Non-x86_64: bundled pi-agent/bin/fd won't run — install fd-find."

c "3/9  MCP config  ->  $H/.kiro/settings/mcp.json  (+ github token)"
run "mkdir -p '$H/.kiro/settings'"
PRIOR_TOK="$(grep -o 'ghp_[A-Za-z0-9]*' "$H/.kiro/settings/mcp.json" 2>/dev/null | head -1)"   # preserve on re-install
bk "$H/.kiro/settings/mcp.json"
run "cp -p '$SRC/kiro-settings/mcp.json' '$H/.kiro/settings/mcp.json'"
rehome "$H/.kiro/settings/mcp.json"
TOK="${GITHUB_MCP_TOKEN:-$PRIOR_TOK}"
if [ -z "$TOK" ] && [ "$DRY" = 0 ] && [ -t 0 ]; then read -rsp '   GitHub MCP token (ghp_… ; Enter to skip): ' TOK; echo; fi
if [ -n "$TOK" ] && [ "$DRY" = 0 ]; then sed -i "s|\${GITHUB_MCP_TOKEN}|$TOK|g" "$H/.kiro/settings/mcp.json"; ok "github MCP token wired"; \
  else warn "github token not set — edit \${GITHUB_MCP_TOKEN} in mcp.json, or re-run with GITHUB_MCP_TOKEN=ghp_…"; fi
ok "mcp.json placed (browser-live, burp, memory, github, medium, gmail)"

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
[ "$DRY" = 0 ] && grep -q '^DEBUG_MODE=' "$GW/.env" 2>/dev/null && { sed -i 's/^DEBUG_MODE=.*/DEBUG_MODE="off"/' "$GW/.env"; ok "DEBUG_MODE=off (was 'all' for debugging)"; }
run "python3 -m venv '$GW/.venv'"
run "'$GW/.venv/bin/pip' install -q --upgrade pip"
run "'$GW/.venv/bin/pip' install -q -r '$GW/requirements.txt'" && ok "gateway venv built"

c "7/9  launchers  ->  $H/.local/bin"
run "mkdir -p '$H/.local/bin'"
for l in xpow-hunt xpow-gateway xpow-model; do [ -f "$SRC/bin/$l" ] || continue; bk "$H/.local/bin/$l"; run "cp -p '$SRC/bin/$l' '$H/.local/bin/$l'"; rehome "$H/.local/bin/$l"; run "chmod +x '$H/.local/bin/$l'"; done
ok "xpow-hunt, xpow-gateway, xpow-model (model toggle)"
case ":$PATH:" in *":$H/.local/bin:"*) :;; *) warn "$H/.local/bin not on PATH — add: export PATH=\"\$HOME/.local/bin:\$PATH\"";; esac

c "8/9  systemd user service (gateway auto-start + self-heal)"
run "mkdir -p '$H/.config/systemd/user'"
if [ "$DRY" = 0 ]; then sed "s|$OLD_HOME|$H|g" "$SRC/systemd/kiro-gateway.service" > "$H/.config/systemd/user/kiro-gateway.service"; ok "unit installed (re-homed)"; else printf '   [dry] render systemd unit\n'; fi
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  run "systemctl --user daemon-reload"; run "systemctl --user enable --now kiro-gateway.service" && ok "service enabled + started"
  run "loginctl enable-linger '$USER_NAME'" && ok "linger enabled"
else warn "systemd --user unavailable. Start manually: cd $GW && ./.venv/bin/python main.py --port $GW_PORT"; fi

c "9/9  verify"
if [ "$DRY" = 0 ]; then sleep 4; HC="$(curl -s -m4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GW_PORT/health" 2>/dev/null)"; \
  [ "$HC" = "200" ] && ok "gateway healthy on :$GW_PORT" || warn "gateway health=${HC:-none} (journalctl --user -u kiro-gateway -n50 ; $GW/gw.log)"; fi
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
AGENTS_N="$(ls "$H/.pi/agent/agents/"*.md 2>/dev/null | wc -l)"
[ "$DRY" = 0 ] && ok "$AGENTS_N specialist agents installed"

cat <<EOF

-----------------------------------------------------------------------------
 xpow-hunt restore complete${DRY:+ (dry-run — nothing changed)}.

 STILL MACHINE-SPECIFIC (can't be copied):
   1. kiro-cli login                         # gateway's auth source
   2. GitHub MCP token                       # GITHUB_MCP_TOKEN=ghp_… ./install.sh  (or edit mcp.json)
   3. Gmail MCP OAuth                         # $H/.gmail-mcp/{gcp-oauth.keys.json,credentials.json} + auth
   4. Burp Suite app + AI-Agent extension     # the bundled jar bridges to Burp on 127.0.0.1:9876

 RUN:
   xpow-hunt                                    # then: Hunt <program> for CRITICAL
-----------------------------------------------------------------------------
EOF
