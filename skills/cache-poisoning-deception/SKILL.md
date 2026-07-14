---
name: cache-poisoning-deception
description: "Web cache poisoning and cache deception methodology: find unkeyed inputs that poison shared cached responses, and path/extension confusion that caches victims' private pages. Auto-loads when a CDN/cache layer is in front of the app (X-Cache/CF-Cache-Status/Age/Via), or when cache-poison-hunter is engaged."
---

# Cache Poisoning & Deception

Two different bugs, both leveraging a shared cache:
- **Poisoning:** you get a malicious response stored in the cache and served to *other* users.
- **Deception:** you trick the cache into storing *another user's private* response where you can read it.

Deep work goes to `cache-poison-hunter`. Pairs with safe-exploitation (never poison a real high-traffic page for real users — prove on a unique/benign key), business-impact (mass impact = High/Critical).

---

## 1. IS THERE A CACHE?
Look for `X-Cache: hit/miss`, `CF-Cache-Status`, `Age`, `Via`, `X-Served-By`, `X-Varnish`. Note what's cached (static extensions, whole pages, API responses) and the apparent **cache key** (usually method + host + path + query; often NOT most headers).

## 2. CACHE POISONING
Find an **unkeyed input** that still changes the response, then get the poisoned response cached.
- Probe unkeyed headers that reflect into the response: `X-Forwarded-Host`, `X-Forwarded-Scheme`, `X-Host`, `X-Forwarded-For`, `X-Original-URL`, `X-Rewrite-URL`, custom `X-*` the app reflects.
  ```
  GET /?cachebuster=1 HTTP/1.1
  X-Forwarded-Host: evil.example
  ```
  If `evil.example` lands in the response body (in an absolute URL, script src, link) AND the response is cacheable → poisoning.
- Escalate: poison a script/import URL → stored XSS to every visitor; poison a redirect `Location` → mass open redirect; poison to inject `<script>`.
- **Cache-key normalization / fat GET / parameter cloaking:** exploit the cache treating `/x` and `/x?` or duplicate params differently from the origin.
- **Cache-key injection / port confusion:** `Host: target:80X` / `parse_url` quirks that keep a poisoned Host in the cached body.
- Always use a unique `?cachebuster=<rand>` so you poison YOUR key during testing, not the live page (safe-exploitation).

## 3. CACHE DECEPTION
Make the cache store a victim's authenticated/private page under a path it wrongly thinks is a static asset.
- Append a fake static suffix/segment to a sensitive authenticated endpoint:
  ```
  /account/profile.css      /account/profile/nonexistent.js      /account;.css      /account%0a.css      /account/..%2fstatic/x.css
  ```
- If the app ignores the suffix and returns the private page, and the cache stores it by extension → request the same URL **unauthenticated** (or as another user) and read the victim's cached private data.
- Confirm with two identities (authz-matrix): victim's browser populates the cache; attacker fetches the same crafted URL and gets victim data.

## 4. CONFIRM + IMPACT (safely)
- Poisoning proof: show the malicious value is served from cache (`X-Cache: hit`) on a request that did NOT send the injected header — but keep it on a unique cachebuster key so no real user is served your payload.
- Deception proof: victim (your own account) loads the crafted URL; a separate unauthenticated request to the same URL returns the victim's private content from cache. Redact PII.
- Impact (business-impact): persistent XSS/redirect to all users, or theft of any user's private page = High/Critical. Note cache TTL and whether a real key could be hit.

## FALSE POSITIVES / SAFETY
- Reflection that is NOT cached (no `hit`, `Cache-Control: private/no-store`) — not poisoning.
- A response cached only for YOUR session/key with a keyed cookie — no cross-user impact.
- Do NOT poison real shared pages or leave a poisoned entry live — test on unique keys and note that a real key is reachable rather than proving it destructively.
