---
name: writeup-intel
description: "Real-world bug bounty writeup intelligence from 2026. Exact techniques, payouts, and attack patterns from confirmed findings. Auto-loads when hunting for CRITICAL or HIGH severity."
---

## CRITICAL-severity routing priority (payout-weighted, 2025-2026)

When hunting for CRITICAL, test surfaces in this order:
1. **SSRF → cloud metadata** ($3.5k-$50k, CVSS 10.0). AWS IMDSv2 bypass, GCP service account chain, Azure managed identity.
2. **Auth bypass / ATO** ($5k-$50k+). OAuth misconfiguration, JWT alg:none/confusion, Next.js middleware bypass (CVE-2025-29927), SAML signature wrapping.
3. **AI/LLM/MCP exploitation** (540% report increase, 339% bounty increase). MCP tool poisoning (72.8% success rate), indirect prompt injection via RAG.
4. **HTTP request smuggling** ($221k from Akamai CVE-2025-32094). HTTP/2 desync, CL.TE/TE.CL differentials.
5. **RCE via prototype pollution** (CVSS 10.0 — Next.js CVE-2025-66478 via RSC). SSTI, deserialization, expression language injection.
6. **Race conditions** (single-packet attack via HTTP/2 multiplexing). Balance manipulation, privilege gate bypass, double-spend.
7. **Web cache deception/poisoning** (ChatGPT ATO example, six-figure cumulative on Next.js).
8. **Path traversal + file upload → RCE** ($111k Meta bounty at BountyCon 2024).
9. **Supply-chain XSS → ATO** ($312.5k Meta CAPIG bounty). SDK/third-party JS injection.
10. **CI/CD pipeline exploitation** (pull_request_target, workflow injection, GITHUB_TOKEN abuse).

## Common program mistakes leading to CRITICAL bugs

- Sequential/predictable tokens for password reset, OTP, session IDs
- SameSite=None on session cookies without CSRF protection
- Missing authorization on GraphQL resolvers
- Hardcoded API keys in frontend JS (AWS AppSync `da2-`, Firebase configs)
- Exposed .git directories in production
- PHP mail() with unsanitized headers → command injection
- Firebase security rules allowing all reads/writes
- Auth0/SSO misconfiguration — missing email domain validation
- Race conditions in payment/email-change/subscription flows
- REST URL path parameter pollution not handled
- Trusting client-side encryption as a security boundary
- No rate limiting on password reset / OTP endpoints
- File upload validation only on client-side
- AI agents processing untrusted data without input sanitization

## Highest-Payout Techniques (2024-2026)

### $312,500 — Meta CAPIG stored XSS → zero-click ATO (ysamm)
- Stored XSS in third-party SDK embedded across 100M+ deployments
- Zero victim interaction needed — XSS fires on page load
- **Lesson**: Supply-chain JS/SDK XSS has massive blast radius. Check every third-party script.

### $111,750 — Meta path traversal + file upload → RCE (BountyCon 2024)
- File upload with path traversal in filename to write webshell to web-accessible directory
- **Lesson**: Combine file upload with path traversal. Test `../../../var/www/html/shell.php` in filenames.

### $66,000 — Facebook PRNG state recovery + DOM XSS → ATO (ysamm)
- `Math.random()` output observable in CSRF tokens/nonces → recover PRNG state → predict future tokens
- Combined with DOM XSS to forge valid CSRF tokens → account takeover
- **Lesson**: If Math.random() is used for security tokens, PRNG state recovery is feasible.

### $62,500 — Facebook self-XSS in payments + CSRF → ATO (ysamm)
- Self-XSS alone = informational. But CSRF on the same page = exploitable XSS → full ATO.
- **Lesson**: ALWAYS check for CSRF when you find self-XSS. The chain is the finding.

### $22,500 — Shopify ATO via POS email verification bypass (NullSecurityX)
- POS auth flow had weaker email verification than main web app
- Two low-friction bugs in alternate auth path = full store ATO
- **Lesson**: Test ALL auth paths (POS, mobile, API, CLI), not just the main web flow.

### $221,000 — Akamai HTTP request smuggling (James Kettle, CVE-2025-32094)
- 74 bounties in 2 weeks from one parser differential CVE
- HTTP/1.1 desync between Akamai CDN and origin servers
- **Lesson**: Request smuggling against major CDNs has massive scope. One desync = hundreds of affected programs.

## Attack Patterns That Hit CRITICAL (2026 Medium writeups)

### Account Takeover Patterns
1. **Email verification bypass in alternate auth flows** (POS, mobile, API) → full ATO
2. **Zero-click org invite abuse** → no victim interaction, invite system is the attack vector
3. **SameSite=None cookie + missing CSRF** → 1-step ATO on modern browsers
4. **SSO email domain not validated** → register with any email → org takeover
5. **REST URL path parameter pollution** → server-side logic manipulation → admin ATO
6. **Weak/sequential password reset tokens** → predict/enumerate → ATO
7. **Single-endpoint email-update race** → admin privilege escalation
8. **IDOR on email-change endpoint** → change victim email → password reset → ATO

### SSRF Patterns
1. **Serverless function triggers** (Azure Functions, Lambda) → trust trigger input → internal access
2. **RSS/Atom/XML feed import** → feed URL is SSRF vector
3. **Avatar/image "import from URL"** → profile picture fetch = SSRF
4. **Legacy enterprise subdomains** → Oracle/PeopleSoft/WebLogic with unauthenticated SSRF

### Race Condition Patterns
1. **Single-endpoint race on email update** → process change before auth check → admin access
2. **Multi-endpoint race (coupon + checkout)** → discount applied after price locked → free items
3. **OTP verification race** → send all attempts simultaneously → bypass rate limiting
4. **Subscription limit race** → create resources concurrently → exceed plan limits
5. **Sequential healthcare tokens + IDOR** → race + enumerate → millions of patient records

### RCE Patterns
1. **PHP mail() 5th parameter (-X flag)** → arbitrary file write → webshell
2. **Next.js middleware bypass + Terraform provider override** → binary replacement → RCE
3. **CrushFTP auth bypass + PHP upload** → reverse shell
4. **Prototype pollution via JSON merge + SSR gadget** → Function constructor → RCE

### Information Disclosure → Critical Chain
1. **`.git` directory exposed** → git-dumper → source code → find auth backdoor/hardcoded creds
2. **AWS AppSync key in JS** (prefix: `da2-`) → test API access scope
3. **Firebase config in JS** → probe RTDB `/.json` → full database access
4. **Source map files** → full client-side source → hidden endpoints, API keys, auth logic

## Testing Checklists (from writeup analysis)

### For Every Authenticated Endpoint
- [ ] IDOR: swap user/resource IDs between accounts
- [ ] Race: concurrent requests via Turbo Intruder
- [ ] Cache deception: append `.css`, `.js`, `.png` → check `X-Cache: HIT`
- [ ] Privilege escalation: modify role/permission params
- [ ] CSRF: check SameSite attribute on session cookies
- [ ] Mass assignment: add `role`, `admin`, `is_admin` to update requests

### For Every API
- [ ] GraphQL introspection: `{__schema{types{name,fields{name}}}}`
- [ ] Parameter pollution: duplicate params in query + body
- [ ] JWT: algorithm confusion (none, RS256→HS256), kid injection
- [ ] Missing auth: access endpoint without Authorization header
- [ ] Rate limiting: test on password reset, OTP, login
- [ ] Batch/bulk abuse: send arrays where singles expected

### For Every Auth Flow
- [ ] Password reset token: request 5+, analyze entropy and patterns
- [ ] OTP: race condition bypass with concurrent requests
- [ ] Email change: race between old/new email states
- [ ] SSO: email domain validation, role assignment during onboarding
- [ ] Session: fixation, SameSite analysis, concurrent session limits
- [ ] OAuth: callback URL validation, state parameter, PKCE enforcement

### For Every URL/Feed Input
- [ ] SSRF to localhost/127.0.0.1/metadata
- [ ] DNS rebinding, redirect chain
- [ ] Protocol smuggling (file://, gopher://)
- [ ] RSS/Atom feed as SSRF vector

### For Every AI/LLM Feature
- [ ] Direct prompt injection (override instructions)
- [ ] Indirect injection via data sources
- [ ] Tool/function call manipulation
- [ ] Data exfiltration via agent output
- [ ] System prompt extraction
- [ ] MCP tool description poisoning


## 2026 Writeup Techniques (Jan–Jun 2026, newly integrated)

Sourced from 2026 disclosed writeups (infosecwriteups, HackerOne Hacktivity) + PortSwigger "Top 10 Web Hacking Techniques 2025" and research-firm/hunter blogs (Assetnote, watchTowr, CTBB, zhero, YesWeHack, elttam, slonser). All are remotely encounterable in web/API hunting. Tech-specific items are tagged with their precondition — route on the fingerprint.

### New CVEs worth fingerprinting for
- **axios ≤1.15.0 SSRF (CVE-2026-42043)** — NO_PROXY/loopback allowlist only matched `127.0.0.1/localhost/::1`; whole `127.0.0.0/8` is loopback. Use `127.0.0.2`, `127.1.2.3`. Prior bypass (CVE-2025-62718): `localhost.`, `[::1]`.
- **Next.js cache poisoning** — "stale elixir" (CVE-2024-46982): `x-now-route-matches: 1` + `__nextDataReq=1` flips SSR→SSG cacheable → 0-click stored XSS if any request value is reflected via getServerSideProps. "Eclipse" (CVE-2025-32421): race the internal `batcher` on `/_error-0` cacheKey. (pages router, self-hosted)
- **Astro x-forwarded-proto pollution (CVE-2025-64525)** — `X-Forwarded-Proto: https://attacker.com/?` concatenated unvalidated into reconstructed URL → SSRF/cache-XSS/middleware-auth bypass.
- **`compressing` npm AFW (CVE-2026-40931)** — patch bypass via pre-planted symlink (git-delivered) + archive entry of same name → write through symlink (Zip-Slip via filesystem TOCTOU).
- **StrongKey FIDO (CVE-2025-26788)**, **Spring Authorization Server DCR (CVE-2026-22752)** — see auth-attack-patterns.

### Highest-value reusable patterns (test these everywhere)
1. **Response-body manipulation on security-critical success states** — Burp "Intercept Response", replace a `400` with a fake success (e.g. MFA setup `{"errorCode":"MFA_AUTHENTICATOR_ALREADY_ACTIVE"}`). Frontends that trust the API response render "MFA enabled" with no real binding. Applies to MFA enroll, permission grants, payment confirmations, access-control checks.
2. **Test EVERY endpoint with NO Authorization header at least once** — missing-auth on read/write endpoints is the most common chain enabler (see chain-patterns 4-phase methodology → mass ATO).
3. **Second-order / out-of-band injection sinks** — input escaped in the web UI is often rendered raw in HTML emails (welcome/verify/contact-confirmation), PDFs, admin panels, logs. Inject `{{7*7}}` and `"><a href=//evil>x</a>` into name/contact fields, then read the EMAIL. Payloads can lie dormant for months.
4. **Runtime secrets in SERVED JS** (shift-left scanners miss these) — DevTools→Network, grep bundles/responses/headers for `client_id/client_secret/AppKey/SubscriptionKey/apiKey`, `__NEXT_DATA__`/`window.__INITIAL_STATE__`, CryptoJS blobs (key sits 3 lines away), runtime `env.js`/`/envs/env.json`. Azure AD `client_credentials` in JS → mint Bearer at `login.microsoftonline.com/{tenant}/oauth2/token` → APIM. Supabase/Firebase anon key → direct `/rest/v1/<table>` or RTDB `/.json`.
4b. **Unauth config endpoints + unrestricted API keys** — `/envs/env.json`, `/config.json`, `/app.config.js` served without auth; validate exposed keys (Google Maps `AIza…` against 10 Maps APIs) → quantify $ billing impact = Critical.
5. **WAF origin-IP unmasking** — when payloads hit 403 at Cloudflare, find the origin (Censys/Shodan: historical SSL cert names, favicon MurmurHash3, analytics ID, copyright/title) and `curl --resolve host:443:ORIGIN` — naked backend often accepts what the edge blocked → file-upload RCE etc.
6. **Schema visibility ≠ exploitability** (GraphQL): always attempt a safe mutation execution before scoring; resolver authz may still block.

### New attack classes to add to the playbook
- **HTTP desync 2025/26**: "funky chunks" (lone-`\n` chunk-extension terminator; 2-byte blind terminator), "single-packet shovel" (HTTP/2 request tunnelling detection via embedded HTTP/1 response), Azure Front Door CL.0 → edge cache 0-click XSS. (see chain-patterns/burp-scan)
- **CSP bypass gadgets**: CRLF "nested response splitting" (inject a full 2nd response → same-origin script beats `script-src 'self'`); nonce reuse via disk-cache; telemetry-domain (New Relic/Sentry) exfil when `connect-src` allowlists them.
- **CSS-injection exfiltration**: `@font-face` unicode-range keylogger (steals CVV/card across split iframes); "fontleak" ligature width-oracle leaks tokens with no JS. Filter bypass: `\40 import`, `\000040font-face`.
- **Client-side ATO upgrades**: `credentialless` iframe turns Self-XSS into real Stored-XSS/ATO; postMessage handlers with no origin check; SVG-as-avatar stored XSS; prototype pollution `__proto__.isAdmin`.
- **ORM Leak** via `filter`/`sort`/`order_by`/`$filter` on hidden columns (password hash, reset token, 2FA secret) — blind char-by-char; pivot through relations (Beego/Prisma/Django/EF/OData).
- **Parser/syntax confusion**: `\N{DOLLAR SIGN}{7*7}` (Python/Perl named-unicode SSTI bypass), `Content-Disposition: filename*` smuggling past `filename`-only filters, `file://host/path`, PHP `parse_url` leading-zero port confusion → cache-poison XSS, schizophrenic ZIP.
- **RRE (Recursive Request Exploits)**: access checked at entry endpoint but not on downstream token/signed-URL/manifest requests — trace request chains backward for unvalidated references.
- **AI/agent**: indirect prompt injection → LLM output rendered unsanitized = stored XSS (can trigger tool actions); MCP tool-parameter SQLi/BOLA → lateral movement; CI/CD AI agents (PromptPwnd) where untrusted issue/PR text reaches a privileged `run_shell_command` tool; persistent agent memory poisoning across sessions/users.
- **Infra/SaaS**: IngressNightmare (unauth Ingress-NGINX admission controller RCE), Mintlify-style server-side MDX → cache-poison mass XSS, .NET SOAPwn (attacker WSDL into SoapHttpClientProtocol → SSRF/deser), Python dirty-AFW → RCE via `.so`/`.pyc`/`.pth`.
