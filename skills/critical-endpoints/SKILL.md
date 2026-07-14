---
name: critical-endpoints
description: "High-hit-rate endpoints, parameters, and headers to test. Auto-loads when specialist agents need target-specific fuzzing lists for IDOR, SSRF, auth bypass, race conditions, or business logic testing."
---

## Commonly Vulnerable Endpoints (from 50+ analyzed 2026 writeups)

### Auth & Account Takeover
- `/password-reset` — token prediction, race conditions, weak entropy
- `/verify-email` — bypass via race or parameter manipulation
- `/invite/accept` — organization invite abuse → zero-click ATO
- `/oauth/callback` — open redirect → token theft
- `/api/auth/sso` — SSO email domain bypass → org takeover
- `/.well-known/openid-configuration` — OAuth endpoint discovery
- `/api/auth/login` — credential stuffing, parameter pollution
- `/api/auth/otp/verify` — race condition bypass, brute force
- `/api/auth/magic-link` — token reuse, predictability

### IDOR / BOLA Targets
- `/api/v1/user/{id}` — horizontal privilege (swap IDs)
- `/api/orders/{id}` — billing data IDOR
- `/api/invoices/{id}` — financial data access
- `/api/comments/{id}/approve` — BOLA in moderation
- `/api/subscription/create` — race condition on plan limits
- `/api/v*/admin/*` — 403 bypass then vertical escalation
- `/graphql` — introspection + nested IDOR via relationships

### SSRF Entry Points
- `/feed/import`, `/rss/add` — RSS/Atom/XML feed parsing
- `/api/upload/from-url` — image/file fetch from URL
- `/api/avatar/import` — profile picture URL fetch
- `/api/webhook/test` — webhook URL validation
- `/api/preview` — URL preview/unfurl features
- `/api/export/pdf` — HTML-to-PDF with URL fetching

### Information Disclosure
- `/.git/HEAD`, `/.git/config` — source code exposure
- `/.env`, `/.env.example` — credential leaks
- `/actuator/env`, `/actuator/heapdump` — Spring Boot
- `/debug`, `/trace`, `/_debug` — debug endpoints
- `/graphql?query={__schema{types{name,fields{name}}}}` — schema leak
- `/api/config`, `/api/settings` — internal configuration

### Business Logic
- `/checkout` — fee manipulation, race conditions
- `/api/coupon/apply` — race for stacking
- `/api/transfer` — balance race condition
- `/api/subscription/upgrade` — plan limit bypass

## High-Hit-Rate Parameters

### Identity (IDOR)
`user_id`, `account_id`, `order_id`, `invoice_id`, `org_id`, `team_id`, `project_id`, `comment_id`, `file_id`, `message_id`

### Auth / Privilege
`role`, `permission`, `is_admin`, `admin`, `access_level`, `group`, `scope`, `token`, `reset_token`, `otp`, `verification_code`

### SSRF / Redirect
`url`, `uri`, `path`, `redirect`, `callback`, `next`, `return_url`, `redirect_uri`, `continue`, `dest`, `target`, `feed_url`, `webhook_url`, `image_url`, `avatar_url`

### File Access
`file`, `filename`, `upload`, `path`, `template`, `include`, `page`, `doc`, `folder`, `attachment`

### Business Logic
`price`, `amount`, `quantity`, `discount`, `coupon`, `promo_code`, `plan`, `tier`, `credits`

### Injection
`query`, `search`, `filter`, `sort`, `order`, `from`, `sender`, `reply-to`, `subject`, `name`, `comment`, `message`

## Headers to Always Check

### Auth Attack Surface
- `Cookie: SameSite=None` — CSRF enabler → chain to ATO
- `Authorization: Bearer` — JWT manipulation (alg:none, RS256→HS256, kid injection)
- `X-API-Key` — hardcoded/leaked API keys

### Bypass Headers
- `X-Forwarded-For`, `X-Real-IP` — IP-based auth/rate-limit bypass
- `X-Original-URL`, `X-Rewrite-URL` — 403 bypass on nginx/IIS
- `X-HTTP-Method-Override` — method restriction bypass
- `X-Forwarded-Host` — cache poisoning, SSRF, host header injection
- `X-Forwarded-Scheme: http` — forced downgrade

### Cache Indicators
- `X-Cache: HIT/MISS` — cache deception target
- `CF-Cache-Status` — Cloudflare cache behavior
- `Age` — cache duration (> 0 = cached)
- `Via` — proxy/CDN presence
- `X-Served-By`, `X-Varnish`, `X-Fastly-Request-ID`, `X-Amz-Cf-Id` — CDN fingerprint

### Framework Detection
- `X-Powered-By` — technology disclosure
- `X-AspNet-Version`, `X-AspNetMvc-Version` — .NET version
- `Server` — web server identification


## 2026 Additions (newly integrated)

### New high-value endpoints
- `/mcp` (+ `llm.*`/`ai.*`, `oauth.*`) — MCP tool surface: test tool params for SQLi/NoSQL/cmd injection and BOLA/tenant isolation (lateral movement)
- `/rest/v1/{table}` — Supabase/PostgREST: enumerate internal tables (`arr_cache`, `internal_metrics`, `admin_data`, `*_cache`) with leaked anon key, missing RLS
- `/graphiql`, `/graphiql?path=/graphql`, `/playground` — exposed IDE / introspection
- `/envs/env.json`, `/config.json`, `/app.config.js`, `/settings.json`, `/api/config` — unauth runtime config / key leak
- `/_next/data/{buildID}/*.json` — Next.js data routes (cache poisoning)
- `/api/.../avatar`, `/upload`, `/invoice`, `/export/pdf`, `/report` — file-upload (SVG/`.aspx`) + PDF/headless SSRF
- `/webhook`, `/callback`, `/uninstall`, `/push/subscribe` — missing-HMAC webhooks; web-push = blind SSRF
- GraphQL `invite`/`addMember`/`share` mutations — user-enumeration + internal-ID/metadata leak
- legacy `GET /profile/password?id=`, `POST /account/info` — unauth read IDOR returning salt+hash / PII (test with NO auth header)

### New high-hit parameters
- Auth/redirect: `callbackUrl`, `returnTo`, `next`, `redirect_uri`
- BAC/clone/assign: `copy_from`, `team_leader_ids`, `copy_team_members`, `userProfileID`, optional `id` + optional `currentPassword` (password change)
- ORM-leak: `filter`, `sort`, `order_by`, `order`, `$filter`, `select`, `include*` (also GraphQL-federation SSRF via `include*` args)
- File/name (control-char + second-order): `dirname`, `filename`, `name`, `fullname`, `company`, `address` (test `%0a`, `{{7*7}}`, `"><a href=//evil>`)
- Price/logic: `amount`, `price`, `coupon_code` (NoSQL `{"$ne":null}`)

### Headers to always test (2026)
- `X-Original-Host`, `X-Forwarded-Host` — cache poisoning (unkeyed); use Param Miner "Guess Headers"
- `X-Forwarded-Proto: https://attacker/?` — Astro URL pollution (CVE-2025-64525)
- `x-now-route-matches: 1` + `__nextDataReq=1` — Next.js cache poisoning
- `Content-Disposition: filename*=UTF-8''…` — smuggle past `filename`-only filters
- SSRF loopback set: `127.0.0.2`/`127.1.2.3` (whole 127/8), `localhost.`, `[::1]`, decimal/octal/uppercase-hex IPv4, `file://host/path`
- Webhook `X-Hub-Signature`/HMAC — test absence/non-verification
