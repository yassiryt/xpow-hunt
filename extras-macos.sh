#!/usr/bin/env bash
# =============================================================================
# xpow-hunt extras — OPTIONAL runtime hunting toolchain  —  macOS adaptation
#
# Faithful macOS port of extras.sh. Differences vs. the Linux original:
#   * Homebrew instead of apt-get; NO sudo (brew + /usr/local are user-owned)
#   * SecLists -> /usr/local/share/seclists (macOS /usr/share is read-only/SIP);
#     the 2 installed framework files that hardcode /usr/share/seclists are
#     repointed. Clone runs in the BACKGROUND (1.9G) so this script returns fast.
#   * go-tool list uses a portable loop (macOS /bin/bash is 3.2, no `declare -A`)
#
# Usage:  ./extras-macos.sh           # install everything it can
#         ./extras-macos.sh --dry-run
# =============================================================================
set -uo pipefail
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
run(){ if [ "$DRY" = 1 ]; then printf '   [dry] %s\n' "$*"; else eval "$@"; fi; }
c(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok(){ printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[1;33m! %s\033[0m\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }
sedi(){ if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
SECLISTS="/usr/local/share/seclists"

[ "$(uname -s)" = "Darwin" ] || warn "this is the macOS port but uname is $(uname -s) — the Linux extras.sh may suit you better."

c "Homebrew packages (jq, nmap, sqlmap, pipx; java/chromium noted)"
if have brew; then
  for pkg in jq nmap sqlmap pipx; do
    bin="$pkg"; [ "$pkg" = "pipx" ] && bin="pipx"
    if have "$bin"; then ok "$pkg present"; else run "brew install $pkg" && ok "installed $pkg" || warn "brew install $pkg failed"; fi
  done
  have java && ok "java present (burp MCP)" || warn "no java — 'brew install openjdk' (burp MCP proxy)."
  { [ -d "/Applications/Google Chrome.app" ] || [ -d "/Applications/Chromium.app" ] || have chromium; } && ok "chrome/chromium present (browser-live)" || warn "no chrome — 'brew install --cask google-chrome' (browser-live)."
else warn "no brew — install Homebrew (https://brew.sh), then jq/nmap/sqlmap/pipx."; fi

c "SecLists  ->  $SECLISTS  (macOS-writable; was /usr/share/seclists on Linux)"
if [ -d "$SECLISTS" ] && [ -n "$(ls -A "$SECLISTS" 2>/dev/null)" ]; then ok "already present at $SECLISTS"
elif [ "$DRY" = 1 ]; then printf '   [dry] background git clone --depth 1 SecLists -> %s\n' "$SECLISTS"
else
  run "mkdir -p '$(dirname "$SECLISTS")'"
  # 1.9G — clone detached so this script returns; progress logged to /tmp.
  nohup git clone --depth 1 https://github.com/danielmiessler/SecLists.git "$SECLISTS" >/tmp/xpowhunt-seclists-clone.log 2>&1 &
  echo "   cloning SecLists in background (pid $!). progress: tail -f /tmp/xpowhunt-seclists-clone.log ; done when 'du -sh $SECLISTS' ≈ 1.9G"
fi
# Repoint the installed framework refs that hardcode the Linux /usr/share/seclists.
if [ "$DRY" = 0 ]; then
  n=0; while IFS= read -r f; do [ -n "$f" ] || continue; sedi "s|/usr/share/seclists|$SECLISTS|g" "$f" && n=$((n+1)); done < <(grep -rIil '/usr/share/seclists' "$HOME/.pi/agent" "$HOME/.kiro" 2>/dev/null)
  [ "$n" -gt 0 ] && ok "repointed $n framework file(s) to $SECLISTS" || warn "no framework refs to /usr/share/seclists found (already repointed?)"
else printf '   [dry] repoint framework /usr/share/seclists refs -> %s\n' "$SECLISTS"; fi

c "Go recon tools  ->  ~/go/bin"
export PATH="$HOME/go/bin:$PATH"
if have go; then
  # portable (no bash-4 associative arrays): "name  import-path" per line
  GO_TOOLS="
httpx      github.com/projectdiscovery/httpx/cmd/httpx@latest
katana     github.com/projectdiscovery/katana/cmd/katana@latest
dnsx       github.com/projectdiscovery/dnsx/cmd/dnsx@latest
naabu      github.com/projectdiscovery/naabu/v2/cmd/naabu@latest
subfinder  github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest
nuclei     github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest
ffuf       github.com/ffuf/ffuf/v2@latest
gau        github.com/lc/gau/v2/cmd/gau@latest
anew       github.com/tomnomnom/anew@latest
unfurl     github.com/tomnomnom/unfurl@latest
qsreplace  github.com/tomnomnom/qsreplace@latest
gf         github.com/tomnomnom/gf@latest
interactsh-client github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest
chaos      github.com/projectdiscovery/chaos-client/cmd/chaos@latest
shuffledns github.com/projectdiscovery/shuffledns/v2/cmd/shuffledns@latest
alterx     github.com/projectdiscovery/alterx/cmd/alterx@latest
tlsx       github.com/projectdiscovery/tlsx/cmd/tlsx@latest
cdncheck   github.com/projectdiscovery/cdncheck/cmd/cdncheck@latest
asnmap     github.com/projectdiscovery/asnmap/cmd/asnmap@latest
uncover    github.com/projectdiscovery/uncover/cmd/uncover@latest
mapcidr    github.com/projectdiscovery/mapcidr/cmd/mapcidr@latest
notify     github.com/projectdiscovery/notify/cmd/notify@latest
urlfinder  github.com/projectdiscovery/urlfinder/cmd/urlfinder@latest
puredns    github.com/d3mondev/puredns/v2@latest
cero       github.com/glebarez/cero@latest
gospider   github.com/jaeles-project/gospider@latest
hakrawler  github.com/hakluke/hakrawler@latest
waybackurls github.com/tomnomnom/waybackurls@latest
subjs      github.com/lc/subjs@latest
getJS      github.com/003random/getJS/v2@latest
jsluice    github.com/BishopFox/jsluice/cmd/jsluice@latest
mantra     github.com/Brosck/mantra@latest
dalfox     github.com/hahwul/dalfox/v2@latest
kxss       github.com/Emoe/kxss@latest
Gxss       github.com/KathanP19/Gxss@latest
crlfuzz    github.com/dwisiswant0/crlfuzz/cmd/crlfuzz@latest
jaeles     github.com/jaeles-project/jaeles@latest
gobuster   github.com/OJ/gobuster/v3@latest
kr         github.com/assetnote/kiterunner/cmd/kr@latest
trufflehog github.com/trufflesecurity/trufflehog/v3@latest
gitleaks   github.com/gitleaks/gitleaks/v8@latest
amass      github.com/owasp-amass/amass/v4/...@master
"
  printf '%s\n' "$GO_TOOLS" | while read -r name path; do
    [ -z "${name:-}" ] && continue
    # httpx clash: a Python 'httpx' may shadow PD httpx; only treat ~/go/bin/httpx as present
    if [ "$name" = "httpx" ]; then [ -x "$HOME/go/bin/httpx" ] && { ok "httpx (PD) present"; continue; }
    else have "$name" && { ok "$name present"; continue; }; fi
    run "go install $path" && ok "installed $name" || warn "go install $name failed"
  done
  case ":$PATH:" in *":$HOME/go/bin:"*) ok "~/go/bin on PATH";; *) warn "add ~/go/bin to PATH: export PATH=\"\$HOME/go/bin:\$PATH\"";; esac
else warn "go not found — 'brew install go', then re-run."; fi

c "pipx / python tools (git-dumper, arjun, paramspider, waymore, dnsgen, clairvoyance, graphw00f)"
if have pipx; then
  for p in git-dumper arjun paramspider waymore dnsgen clairvoyance graphw00f; do
    have "$p" && { ok "$p present"; continue; }
    run "pipx install $p" && ok "$p" || warn "pipx install $p failed (some need git+URL; see notes)"
  done
  run "pipx ensurepath >/dev/null 2>&1 || true"
else warn "pipx missing — 'brew install pipx' then re-run."; fi

c "brew tools: feroxbuster, findomain, massdns (shuffledns/puredns resolver backend)"
if have brew; then
  for b in feroxbuster findomain massdns; do have "$b" && { ok "$b present"; continue; }; run "brew install $b" && ok "$b" || warn "brew install $b failed"; done
else warn "no brew — install feroxbuster/findomain/massdns manually."; fi

c "cargo (Rust) tool: x8 (hidden-param mining)"
if have cargo; then have x8 && ok "x8 present" || { run "cargo install x8" && ok "x8" || warn "cargo install x8 failed"; }
else warn "cargo missing — 'brew install rust' then 'cargo install x8'."; fi

c "git-only tools  ->  ~/tools  (Corsy CORS scanner, LinkFinder JS endpoints)"
run "mkdir -p '$HOME/tools'"
if [ -d "$HOME/tools/Corsy" ]; then ok "Corsy present"; else run "git clone --depth 1 https://github.com/s0md3v/Corsy '$HOME/tools/Corsy'" && ok "Corsy (run: python3 ~/tools/Corsy/corsy.py)" || warn "Corsy clone failed"; fi
if [ -d "$HOME/tools/LinkFinder" ]; then ok "LinkFinder present"; else run "git clone --depth 1 https://github.com/GerbenJavado/LinkFinder '$HOME/tools/LinkFinder'" && ok "LinkFinder (run: python3 ~/tools/LinkFinder/linkfinder.py)" || warn "LinkFinder clone failed"; fi

c "notes"
warn "PD httpx vs python httpx: ensure ~/go/bin precedes ~/Library/Python/*/bin in PATH so the recon httpx wins."
warn "nuclei: run 'nuclei -update-templates' once; clone fuzzing-templates: git clone https://github.com/projectdiscovery/fuzzing-templates ~/fuzzing-templates"
warn "interactsh-client (OOB) is the decisive blind-vuln proof — verify it runs: 'interactsh-client -v'."
warn "jaeles: run 'jaeles config init' once to fetch signatures. naabu uses libpcap (bundled with macOS); if it errors, 'brew install libpcap'."
warn "protonvpn: macOS app from protonvpn.com (no official CLI on brew)."
echo
echo "Done${DRY:+ (dry-run)}. Runtime tools only — xpow-hunt's own setup comes from ./install-macos.sh."
