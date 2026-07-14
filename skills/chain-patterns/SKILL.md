---
name: chain-patterns
description: "Vulnerability chain patterns that escalate low/medium findings to CRITICAL. Auto-loads when security-analyzer performs chain synthesis or when any specialist discovers a low-severity signal."
---

## Confirmed Chain Patterns (from 2024-2026 writeups with real payouts)

### Tier 1: Chains to CRITICAL (proven payouts)

| Chain | Components | Impact | Reference |
|-------|-----------|--------|-----------|
| SSRF → cloud metadata → IAM creds | SSRF + 169.254.169.254 | Full cloud account takeover, RCE | Azure OpenAI CVE-2025-53767 (CVSS 10.0) |
| Prototype pollution → SSR gadget → RCE | `__proto__` + Function constructor | Server-side code execution | Next.js CVE-2025-66478 (CVSS 10.0) |
| Open redirect → OAuth callback → token theft | Open redir + OAuth | Full ATO at scale | Multiple programs |
| Self-XSS + CSRF → exploitable XSS → ATO | Self-XSS + missing CSRF | Session/cookie theft | $62.5k Facebook |
| Supply-chain XSS → zero-click ATO | Third-party SDK XSS | ATO at deployment scale | $312.5k Meta CAPIG |
| SameSite=None + CSRF → sensitive action | Cookie misconfig + no CSRF token | 1-step ATO | rijndael writeup (2026) |
| Email verification bypass + POS auth flaw | Weak verification + alt flow | Full store ATO | $22.5k Shopify |
| SSO email domain bypass + privilege escalation | SSO misconfig + no domain validation | Full organization takeover | ali alhassoun (2026) |
| .git exposure → source code → auth backdoor | Info disclosure + code review | Any-account login | zoid/zoidsec (2026) |
| Path traversal + file upload → webshell | LFI/upload + write access | RCE | $111k Meta BountyCon |
| PHP mail() -X flag + file write | Header injection + sendmail flag | Webshell → RCE | NullSecurityX (2026) |
| HTTP/2 desync → cache poison → stored XSS | Parser differential + CDN cache | Mass exploitation | $221k Akamai CVE-2025-32094 |
| Blind SSRF + byte-by-byte oracle | Blind SSRF + response differential | Arbitrary file read | XBOW (32 steps, 14 min) |
| IDOR + race condition + sequential tokens | IDOR + race + predictability | Mass data exposure (millions) | Healthcare writeup (2026) |
| Multi-endpoint race (coupon + checkout) | Race between payment steps | Purchase items for free | Bash Overflow (2026) |
| Next.js middleware bypass + auth bypass + traversal | `x-middleware-subrequest` + dir traversal | RCE chain | CVE-2025-29927 + bluesnow |
| GraphQL introspection + chained IDORs | Schema leak + nested object access | Mass PII exfiltration | Thrive Global writeup |

### Tier 2: Chains to HIGH (reliable escalation)

| Chain | Components | Impact |
|-------|-----------|--------|
| Blind XSS in admin panel + privilege context | Stored XSS + admin renders input | Admin ATO |
| IDOR + missing rate limit | Object access + no throttle | Mass enumeration of PII |
| Race condition + subscription bypass | Concurrent requests + plan limits | Business logic bypass |
| CORS misconfiguration + sensitive endpoint | Wildcard/null origin + auth data | Cross-origin data theft |
| Login CSRF + stored XSS in auth area | Session fixation + XSS | Session hijack |
| Web cache deception + auth endpoint | Path normalization + CDN cache | Credential/token theft at scale |
| CRLF injection + cache layer | Header injection + CDN | Cache poisoning → mass XSS |
| OTP race condition + account access | Concurrent OTP attempts | Auth bypass → ATO |
| Server-side param pollution + REST API | Path injection + API manipulation | Admin ATO |
| Firebase rules misconfig + direct RTDB | No auth rules + /.json access | Full database read/write |

### Tier 3: Escalation Building Blocks (hold, don't discard)

These are NOT findings alone but become CRITICAL when chained:
- Open redirect (any) → check if OAuth callbacks or SSRF targets reachable through it
- CORS with `Access-Control-Allow-Credentials: true` → check what sensitive endpoints return
- Information disclosure (version, path, config) → feed into targeted exploit research
- Self-XSS → immediately check for CSRF on the same page
- Subdomain takeover → check if parent domain cookies are scoped to include the subdomain
- Any 403 bypass → check what's behind it (admin panel, API, internal tools)

## Chain Discovery Heuristics

When reviewing ANY finding, run these checks before closing:

1. **Found an open redirect?** → Test as OAuth callback redirect, SSRF redirect chain, cache poisoning via `X-Forwarded-Host`
2. **Found XSS?** → Check if CSRF protection is missing (chain to ATO). Check HttpOnly flag on session cookies. Check localStorage/sessionStorage for tokens.
3. **Found SSRF?** → Hit cloud metadata immediately. If blind, try byte-by-byte oracle.
4. **Found cache HIT on auth page?** → Web cache deception confirmed. Test from unauth session.
5. **Found prototype pollution?** → Check for SSR gadgets (EJS, Pug, Handlebars, Next.js RSC).
6. **Found IDOR?** → Race it. Also check for missing rate limits.
7. **Found any injection?** → Check if execution context allows OS commands.
8. **Found path traversal?** → Check for write access. Check for .env, credential files.
9. **Found race condition?** → Combine with IDOR for amplified impact (double-spend, mass action).
10. **Found info disclosure?** → Feed into targeted framework exploit research.


## 2026 Chains (newly integrated)

### Tier 1 (proven CRITICAL chains, 2026)
| Chain | Components | Impact | Source |
|-------|-----------|--------|--------|
| Anonymous JS-catalog → user-enum → unauth read IDOR → BOLA password-write | preloaded post-login bundle leaks API catalog + seed admin → verbose login enum → `GET /profile/password?id=` (salt+hash, no auth) → `PUT /profile/password{id,newPassword}` optional currentPassword | Mass ATO of ~5000 accounts | 4-phase methodology (2026) |
| WAF origin-IP unmask → naked backend file upload → RCE | Censys/favicon/cert OSINT + `curl --resolve` → upload `.aspx` w/ `Content-Type: image/png` | Full server takeover behind Cloudflare | "No 0-day RCE kill chain" |
| Runtime secret in JS → cloud token → API/ATO | Azure AD `client_credentials` (or Supabase anon key) in served bundle → `oauth2/token` Bearer → APIM/PostgREST over-scoped read | Full account/data takeover | "Secrets That Survive Everything"; AI-company Supabase ARR leak |
| Blind SSRF redirect-loop → metadata creds | incrementing-status redirect chain forces libcurl client to leak full chain incl. final 200 → `169.254.169.254` | Blind→full-read SSRF → AWS creds | Assetnote 2025 |
| GraphQL federation SSRF → cloud creds → S3 | field arg concatenated into internal subgraph URL → `169.254.169.254` → multi-bucket | Cloud account / data-store compromise | fmisec 2026 |
| HTTP/2 CL.0 / desync → edge cache poison → 0-click XSS | Azure Front Door CL.0; or Next.js stale-elixir/Eclipse internal cache | Mass stored XSS / redirect at edge | AFD MSRC; zhero CVE-2024-46982/CVE-2025-32421 |
| Self-XSS → `credentialless` iframe → ATO | login-CSRF attacker acct in credentialless iframe + victim in normal iframe (same origin) → read cookie / `eval` in victim ctx | "won't fix" Self-XSS → full ATO | slonser 2025 |
| Trojan PR → GitHub Actions RCE → release-secret theft | missing `distributionSha256Sum` in mvnw/gradlew → PR runs poisoned wrapper → post-merge release.yml leaks OSSRH/GPG | Supply-chain prod compromise | "Trojan PR" 2026 |
| Server-side MDX/template (Mintlify) → SSR exec → cache-poison | attacker MDX `{eval(fetch(...))}` rendered server-side → poison shared Next cache | SSR RCE + tenant-wide XSS | kibty.town 2026 |
| Open redirect (`callbackUrl`) → OAuth code/`javascript:` XSS → ATO | `?callbackUrl=//target@evil` + `javascript:alert(document.cookie)` when `<>` filtered | Session theft → ATO | 2026 + page.line.me H1 |

### Tier 2 (reliable escalation, 2026)
| Chain | Components | Impact |
|-------|-----------|--------|
| MFA response-manipulation → silent no-MFA account | Burp Intercept-Response fakes setup success | "security theater" — victim believes protected |
| Second-order email injection → SSTI/phishing | `{{7*7}}`/hyperlink in name/contact field rendered in brand email | RCE (template) or trusted-domain phishing |
| Race on "first user = admin" / role-grant | concurrent signups via `threading.Barrier` / single-packet | N super-admins / privilege gate bypass |
| Newline `%0a` in resource name → broken revocation | malformed name breaks delete/revoke path | persistent elevated access + denial-of-control |
| ORM-leak (`filter`/`sort`/`order_by`) → secret exfil | order/filter by hidden column, blind char-by-char | password-hash/reset-token/2FA exfil |
| CSP bypass: CRLF nested-response / nonce disk-cache / telemetry-domain | inject 2nd same-origin response, or replay cached nonce, or exfil via allowlisted New Relic | XSS/exfil despite strict CSP |

### The 4-Phase "Toxic Combination" Methodology (apply to every target)
A Low + a Medium + a High routinely compose into a Critical that no scanner flags. Start from the lowest-privilege (ideally unauth) position and carry each phase's output into the next:
1. **Information gathering** — "What does the app teach me just by being here?" Read every JS bundle (esp. preloaded ones), TODO comments, seed/test accounts, API catalogs, SSR state blobs.
2. **Vulnerability analysis** — "Which inputs identify objects, and which are NOT bound to my session?" Verbose login/enum oracles, predictable IDs, internal node IDs.
3. **Attack execution** — "Does the same identifier work on a WRITE endpoint, and was auth required at all?" Test every endpoint with no Authorization header. An optional-`id` + optional-`currentPassword` signature = two paths, one skips the check.
4. **Exploitation** — "Can the chain produce a state change the threat model won't detect?" Mass password-reset + normal login looks legitimate to monitoring.

### New chain-discovery heuristics (add to the closing checklist)
- **Found a `credentialless`/iframe-embeddable page + any Self-XSS?** → upgrade to ATO via same-origin iframe pair.
- **Found CRLF / header reflection?** → nested-response-splitting CSP gadget; cache-poison.
- **Found a framework cache (Next.js/AFD/Fastly)?** → cache-poison/deception for 0-click stored XSS; check `x-now-route-matches`, `__nextDataReq`.
- **Found a filter/sort/search param backed by an ORM?** → ORM-leak hidden columns.
- **Found a URL/host field reaching a server-side fetcher (incl. GraphQL arg, webhook, PDF, federation)?** → OOB canary → metadata.
- **Found an AI assistant that ingests user data?** → indirect prompt injection → unsanitized output XSS / tool action.
- **Found access granted at an entry endpoint?** (RRE) → replay the downstream token/signed-URL/manifest request without auth.
