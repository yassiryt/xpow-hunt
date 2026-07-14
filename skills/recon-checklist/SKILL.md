---
name: recon-checklist
description: "Structured recon checklist with mandatory high-signal steps. Auto-loads when recon agent starts surface mapping. Ensures no high-value discovery step is skipped."
---

## Mandatory Recon Steps (ordered by signal-to-noise ratio)

### Phase 1: Passive OSINT (no interaction with target)

- [ ] **Subdomain enumeration** (7 sources): HackerTarget, crt.sh, CertSpotter, AnubisDB, URLScan, RapidDNS, DNSRepo
- [ ] **Endpoint enumeration** (4 sources): Wayback Machine, Common Crawl, AlienVault OTX, URLScan
- [ ] **THC queries**: `ip.thc.org/sb/` and `ip.thc.org/cn/` for each root domain
- [ ] **DNS resolution**: httpx/dnsx on all subdomains → live hosts
- [ ] **Certificate transparency**: crt.sh for recently issued certs (new subdomains)

### Phase 2: JavaScript Analysis (70% actionable hit rate — HIGHEST SIGNAL)

- [ ] **Collect all JS assets**: Crawl with katana or browser-live. Save to `js_assets.txt`.
- [ ] **Source map discovery**: Check `.js.map` alongside every `.js` file
- [ ] **Secret extraction** (regex patterns):
  - API keys: `AIza`, `AKIA`, `sk-`, `rk_`, `pk_`, `ghp_`, `github_pat_`, `glpat-`, `xoxb-`, `xoxp-`
  - AWS AppSync: `da2-[a-zA-Z0-9]{26}`
  - Firebase: `apiKey.*AIza`, `authDomain.*firebaseapp.com`, `databaseURL.*firebaseio.com`
  - Internal endpoints: `https?://[a-z0-9-]+\.(internal|corp|local|staging|dev|test)\.[a-z]+`
  - Hardcoded tokens: `token.*[=:].*['"][a-zA-Z0-9_-]{20,}['"]`
- [ ] **Route extraction**: All URL patterns, API routes, GraphQL endpoints from JS
- [ ] **Admin route discovery**: `/admin`, `/dashboard`, `/internal`, `/debug`, `/manage`
- [ ] **GraphQL schema fragments**: Type definitions, query structures in JS bundles

### Phase 3: Auth & OAuth Discovery

- [ ] **OAuth endpoints**: `/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server`
- [ ] **OAuth flow mapping**: `/authorize`, `/token`, `/callback`, `/revoke`, `/userinfo`
- [ ] **Extract**: `client_id`, `redirect_uri` patterns, `response_type`, `scope`, `state` usage
- [ ] **IdP identification**: Google, GitHub, Microsoft, Okta, Auth0, custom
- [ ] **Cookie analysis**: Check ALL cookies for `SameSite=None`, `HttpOnly`, `Secure` flags
- [ ] **Session mechanism**: JWT vs server-side sessions, token format and entropy

### Phase 4: Framework Fingerprinting

- [ ] **Next.js**: `/_next/` paths, `__NEXT_DATA__`, `x-nextjs-*` headers
- [ ] **Spring Boot**: `/actuator/health`, `Whitelabel Error Page`, `/actuator/env`
- [ ] **Express**: `X-Powered-By: Express`, `connect.sid` cookie
- [ ] **Django**: `csrfmiddlewaretoken`, `/admin/login/`
- [ ] **Rails**: `X-Request-Id`, `_session_id` cookie, sequential integer IDs
- [ ] **PHP/Laravel**: `PHPSESSID`, `laravel_session`, `/vendor/`
- [ ] **ASP.NET**: `__VIEWSTATE`, `.aspx`, `ASP.NET_SessionId`

### Phase 5: Cache & CDN Fingerprinting

- [ ] **Cache headers on every host**: `X-Cache`, `CF-Cache-Status`, `Age`, `Via`, `X-Served-By`
- [ ] **CDN identification**: Cloudflare, Fastly, Akamai, CloudFront, Varnish
- [ ] **Cache rules mapping**: Which extensions/paths are cached?
- [ ] **Record targets**: Hosts with caching → immediate @cache-poison-hunter targets

### Phase 6: High-Value Surface Discovery

- [ ] **`.git/HEAD`** check on every host → source code exposure
- [ ] **`.env`** check: `/.env`, `/.env.example`, `/.env.backup`, `/.env.old`
- [ ] **Firebase**: `/.json` endpoint on suspected Firebase RTDB hosts
- [ ] **Debug/admin endpoints**: `/_debugbar/`, `/telescope/`, `/debug/`, `/trace/`
- [ ] **CI/CD artifacts**: `/.github/workflows/`, `Jenkinsfile`, `Dockerfile`
- [ ] **RSS/feed features**: Any import/subscribe/add-feed functionality → SSRF candidate
- [ ] **Invite/team endpoints**: Organization invite flows → ATO candidate
- [ ] **Content moderation APIs**: Comment approval/rejection → BOLA candidate
- [ ] **POS/alternate auth flows**: Non-web auth paths → weaker verification

### Phase 7: Negative Recon

- [ ] **Invalid methods**: OPTIONS, TRACE, PUT, DELETE on all endpoints
- [ ] **Malformed routes**: URL encoding, double encoding, null bytes
- [ ] **Parameter casing**: `userId` vs `user_id` vs `UserID` — differential = parser inconsistency
- [ ] **Content-Type switching**: JSON vs XML vs form-encoded on same endpoint

## Artifact Files (mandatory output)

| File | Content |
|------|---------|
| `subdomains_all.txt` | All discovered subdomains |
| `subdomains_live.txt` | Responding subdomains |
| `hosts_resolved.txt` | IP resolutions |
| `routes.txt` | All discovered URL paths |
| `params.txt` | All discovered parameters |
| `js_assets.txt` | All JavaScript file URLs |
| `js_secrets.txt` | Secrets/keys found in JS |
| `api_hosts.txt` | API endpoints |
| `oauth_endpoints.txt` | OAuth/OIDC endpoints |
| `cache_indicators.txt` | Hosts with cache layer |
| `tech-stack.md` | Framework fingerprints per host |
| `takeover_candidates.txt` | Strong takeover signals only |
| `takeover_weak_signals.txt` | Weak/unconfirmed signals |
| `manifest.md` | Summary and file inventory |


## 2026 High-Signal Recon Additions (newly integrated)

### Runtime secret scanning in SERVED responses (shift-left scanners miss these)
Open DevTools → Network and read what is actually served (not just source):
- **JS bundles** (pretty-print/de-obfuscate): `client_id`, `client_secret`, `AppKey`, `Ocp-Apim-Subscription-Key`/`SubscriptionKey`, `apiKey`, high-entropy strings. Azure AD `client_credentials` in JS → mint Bearer at `https://login.microsoftonline.com/{tenant}/oauth2/token` → APIM.
- **CryptoJS-encrypted config blobs** — the decryption key sits within a few lines; `CryptoJS.AES.decrypt(blob,key).toString(CryptoJS.enc.Utf8)` in console.
- **SSR state**: `__NEXT_DATA__`, `window.__INITIAL_STATE__` (tokens, internal config).
- **Runtime config endpoints (unauth)**: `/envs/env.json`, `/env.json`, `/config.json`, `/app.config.js`, `/settings.json`, `/api/config`. Validate any key found (Google Maps `AIza…` vs 10 Maps APIs; AWS AppSync `da2-`; Supabase/Firebase).
- **Request headers** on outbound API calls (subscription keys, bearer tokens) and **JSON/XML response fields** that leak creds.
- Bundles often load full config even on auth-required/error pages.

### Source maps & VCS
- `*.js.map` next to every bundle → reconstruct with sourcemapper → `sk_live_`, internal admin endpoints, hidden routes.
- `.git` exposed → git-dumper/GitTools → `git log -p | grep -E 'password|secret|key|token|AKIA|sk_live'` (removed secrets persist in history).
- GitHub dorks: `org:TARGET filename:.env ("AKIA" OR "sk_live" OR "APP_KEY" OR "DB_PASSWORD")`; backup variants `.env.bak/.old/.save/.local/.production`.

### WAF origin-IP unmasking (when the edge blocks payloads)
- Censys/Shodan/FOFA: `host.services.cert.names:"target.com"`, favicon MurmurHash3 (`favicons.hash_md5`), analytics/UA ID in body, copyright string, `web.endpoints.http.html_title:"…"`; combine with non-standard ports (22/3306/8080/27017).
- Verify: `curl -i -k --resolve target.com:443:ORIGIN_IP -H "Host: target.com" https://target.com/path` → 200 without `CF-RAY`/`cf-cache-status` = origin reachable → route Burp at the origin.

### Surface discovery additions
- **MCP / AI surfaces**: `/mcp`, `llm.*`/`ai.*` subdomains, `oauth.*` (MCP auth); AI chat/assistant fields → route to @llm-hunter.
- **GraphQL**: path wordlist `/graphql /graphiql /graphiql?path=/graphql /api/graphql /v1/graphql /playground`; introspection on → enumerate queries (reset-token/PII) and mutations; in federation, note args concatenated into internal URLs.
- **PDF/invoice/report generators** (headless Chrome/PrinceXML) — SSRF/HTML-injection surface.
- **Webhooks** (`/webhook`, `/callback`, `/uninstall`) — check for missing HMAC signature validation.
- **Web push / notification subscription endpoints** — server-fetched URL = blind SSRF.

### Framework fingerprint additions
- **Astro**: honors `x-forwarded-host/-proto/-port`. **Supabase**: `supabase.co` URLs + `eyJ…` anon key in JS → `/rest/v1/`. **Next.js cache**: `x-now-route-matches`, `__nextDataReq`, `/_next/data/{buildID}`. **MCP**: `/mcp` + tool list. Add these to `tech-stack.md`.
