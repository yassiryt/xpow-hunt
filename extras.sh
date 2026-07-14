#!/usr/bin/env bash
# =============================================================================
# xpow-hunt extras — OPTIONAL runtime hunting toolchain (NOT part of xpow-hunt config)
#
# install.sh restores the xpow-hunt FRAMEWORK (agent, gateway, MCPs, prompts).
# This script installs the external CLI tools + wordlists the specialist agents
# invoke at runtime via the shell. Best-effort: it prints what it can't do.
#
# Usage:  ./extras.sh           # install everything it can
#         ./extras.sh --dry-run
# Needs sudo for apt + SecLists. Go tools install to ~/go/bin (add to PATH).
# =============================================================================
set -uo pipefail
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
run(){ if [ "$DRY" = 1 ]; then printf '   [dry] %s\n' "$*"; else eval "$@"; fi; }
c(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok(){ printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[1;33m! %s\033[0m\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && have sudo && SUDO="sudo"

c "apt packages (jq, nmap, sqlmap, java, chromium, pipx, golang)"
if have apt-get; then
  run "$SUDO apt-get update -y"
  run "$SUDO apt-get install -y jq nmap sqlmap default-jre chromium pipx golang-go git curl unzip build-essential libpcap-dev cargo"
  ok "apt packages requested"
else warn "no apt-get — install jq/nmap/sqlmap/java/chromium/go/pipx via your package manager."; fi

c "SecLists  ->  /usr/share/seclists  (1.9G; agents reference this path)"
if [ -d /usr/share/seclists ]; then ok "already present"
elif have apt-get; then
  run "$SUDO apt-get install -y seclists" || { warn "apt seclists failed — cloning"; run "$SUDO git clone --depth 1 https://github.com/danielmiessler/SecLists.git /usr/share/seclists"; }
else run "$SUDO git clone --depth 1 https://github.com/danielmiessler/SecLists.git /usr/share/seclists"; fi

c "Go recon tools  ->  ~/go/bin"
export PATH="$HOME/go/bin:$PATH"
if have go; then
  declare -A GO=(
    [httpx]="github.com/projectdiscovery/httpx/cmd/httpx@latest"
    [katana]="github.com/projectdiscovery/katana/cmd/katana@latest"
    [dnsx]="github.com/projectdiscovery/dnsx/cmd/dnsx@latest"
    [naabu]="github.com/projectdiscovery/naabu/v2/cmd/naabu@latest"
    [subfinder]="github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest"
    [nuclei]="github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
    [ffuf]="github.com/ffuf/ffuf/v2@latest"
    [gau]="github.com/lc/gau/v2/cmd/gau@latest"
    [anew]="github.com/tomnomnom/anew@latest"
    [unfurl]="github.com/tomnomnom/unfurl@latest"
    [qsreplace]="github.com/tomnomnom/qsreplace@latest"
    [gf]="github.com/tomnomnom/gf@latest"
    # --- extended arsenal (align with modern-tooling-2026 skill) ---
    # OOB confirmation (blind SSRF/RCE/XXE/SSTI = CRITICAL proof) — highest value
    [interactsh-client]="github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest"
    # subdomain/DNS/ASN/CDN recon
    [chaos]="github.com/projectdiscovery/chaos-client/cmd/chaos@latest"
    [shuffledns]="github.com/projectdiscovery/shuffledns/v2/cmd/shuffledns@latest"
    [alterx]="github.com/projectdiscovery/alterx/cmd/alterx@latest"
    [tlsx]="github.com/projectdiscovery/tlsx/cmd/tlsx@latest"
    [cdncheck]="github.com/projectdiscovery/cdncheck/cmd/cdncheck@latest"
    [asnmap]="github.com/projectdiscovery/asnmap/cmd/asnmap@latest"
    [uncover]="github.com/projectdiscovery/uncover/cmd/uncover@latest"
    [mapcidr]="github.com/projectdiscovery/mapcidr/cmd/mapcidr@latest"
    [notify]="github.com/projectdiscovery/notify/cmd/notify@latest"
    [puredns]="github.com/d3mondev/puredns/v2@latest"
    [cero]="github.com/glebarez/cero@latest"
    # URL + JS discovery
    [urlfinder]="github.com/projectdiscovery/urlfinder/cmd/urlfinder@latest"
    [gospider]="github.com/jaeles-project/gospider@latest"
    [hakrawler]="github.com/hakluke/hakrawler@latest"
    [waybackurls]="github.com/tomnomnom/waybackurls@latest"
    [subjs]="github.com/lc/subjs@latest"
    [getJS]="github.com/003random/getJS/v2@latest"
    [jsluice]="github.com/BishopFox/jsluice/cmd/jsluice@latest"
    [mantra]="github.com/Brosck/mantra@latest"
    # vuln quick-wins
    [dalfox]="github.com/hahwul/dalfox/v2@latest"
    [kxss]="github.com/Emoe/kxss@latest"
    [Gxss]="github.com/KathanP19/Gxss@latest"
    [crlfuzz]="github.com/dwisiswant0/crlfuzz/cmd/crlfuzz@latest"
    [jaeles]="github.com/jaeles-project/jaeles@latest"
    # content/API discovery
    [gobuster]="github.com/OJ/gobuster/v3@latest"
    [kr]="github.com/assetnote/kiterunner/cmd/kr@latest"
    # secret scanning
    [trufflehog]="github.com/trufflesecurity/trufflehog/v3@latest"
    [gitleaks]="github.com/gitleaks/gitleaks/v8@latest"
    # subdomain (OWASP)
    [amass]="github.com/owasp-amass/amass/v4/...@master"
  )
  for t in "${!GO[@]}"; do have "$t" && { ok "$t present"; continue; }; run "go install ${GO[$t]}" && ok "installed $t"; done
  case ":$PATH:" in *":$HOME/go/bin:"*) :;; *) warn "add ~/go/bin to PATH: export PATH=\"\$HOME/go/bin:\$PATH\"";; esac
else warn "go not found — skipping projectdiscovery/tomnomnom tools."; fi

c "pipx / python tools (git-dumper, arjun, paramspider, waymore, dnsgen, clairvoyance, graphw00f)"
if have pipx; then
  for p in git-dumper arjun paramspider waymore dnsgen clairvoyance graphw00f; do
    have "$p" && { ok "$p present"; continue; }
    run "pipx install $p" && ok "$p" || warn "pipx install $p failed (some need git+URL; see notes)"
  done
  run "pipx ensurepath >/dev/null 2>&1 || true"
else warn "pipx missing — '$SUDO apt-get install -y pipx' then re-run (arjun/paramspider/waymore/dnsgen/clairvoyance/graphw00f)."; fi

c "cargo (Rust) tools: x8 (hidden-param mining), feroxbuster (recursive content discovery)"
if have cargo; then
  for r in x8 feroxbuster; do have "$r" && { ok "$r present"; continue; }; run "cargo install $r" && ok "$r" || warn "cargo install $r failed"; done
else warn "cargo missing — '$SUDO apt-get install -y cargo' (x8); feroxbuster also via apt/snap."; fi

c "standalone binaries: findomain, massdns (shuffledns/puredns resolver backend)"
if have findomain; then ok "findomain present"; else
  run "curl -sSL https://github.com/findomain/findomain/releases/latest/download/findomain-linux.zip -o /tmp/findomain.zip && (cd /tmp && unzip -o findomain.zip && chmod +x findomain && $SUDO mv findomain /usr/local/bin/)" && ok "findomain" || warn "findomain manual: github.com/findomain/findomain/releases"; fi
if have massdns; then ok "massdns present"; else
  run "git clone --depth 1 https://github.com/blechschmidt/massdns /tmp/massdns && make -C /tmp/massdns && $SUDO cp /tmp/massdns/bin/massdns /usr/local/bin/" && ok "massdns" || warn "massdns manual build: github.com/blechschmidt/massdns"; fi

c "git-only tools  ->  ~/tools  (Corsy CORS scanner, LinkFinder JS endpoints)"
run "mkdir -p '$HOME/tools'"
if [ -d "$HOME/tools/Corsy" ]; then ok "Corsy present"; else run "git clone --depth 1 https://github.com/s0md3v/Corsy '$HOME/tools/Corsy'" && ok "Corsy (run: python3 ~/tools/Corsy/corsy.py)" || warn "Corsy clone failed"; fi
if [ -d "$HOME/tools/LinkFinder" ]; then ok "LinkFinder present"; else run "git clone --depth 1 https://github.com/GerbenJavado/LinkFinder '$HOME/tools/LinkFinder'" && ok "LinkFinder (run: python3 ~/tools/LinkFinder/linkfinder.py)" || warn "LinkFinder clone failed"; fi

c "notes"
warn "protonvpn-cli: add Proton's official repo (distro-specific) — see protonvpn.com/support/linux-vpn-tool."
warn "naabu needs libpcap-dev; nuclei: run 'nuclei -update-templates' once, and clone fuzzing-templates: git clone https://github.com/projectdiscovery/fuzzing-templates ~/fuzzing-templates"
warn "interactsh-client (OOB) is the decisive blind-vuln proof — verify it runs: 'interactsh-client -v'."
warn "jaeles: run 'jaeles config init' once to fetch signatures. kr (kiterunner): fetch assetnote routes wordlists."
warn "paramspider/waymore/clairvoyance/graphw00f: if pipx fails, use 'pipx install git+https://github.com/<org>/<repo>'."
echo
echo "Done${DRY:+ (dry-run)}. These are runtime tools only — xpow-hunt's own setup comes from ./install.sh."
