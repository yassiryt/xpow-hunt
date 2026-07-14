---
name: auth-attack-patterns
description: "OAuth, JWT, SAML, SSO, and session attack patterns for authentication bypass and account takeover. Auto-loads when oauth-hunter or any specialist encounters auth surfaces."
---

## OAuth/OIDC Attack Patterns

### 1. Missing `state` parameter → CSRF login
- If OAuth flow lacks `state`, attacker initiates OAuth with their account → victim completes flow → attacker's account linked to victim's session
- Test: Remove `state` param from `/authorize` request. If flow completes, CSRF → ATO.

### 2. Open `redirect_uri` validation → token theft
- Subdomain matching: `https://evil.target.com/callback`
- Path traversal: `/callback/../evil`
- Parameter pollution: `redirect_uri=legit&redirect_uri=evil`
- Fragment injection: `redirect_uri=legit#@evil.com`
- Encoded: `redirect_uri=https%3A%2F%2Fevil.com`
- Null byte: `redirect_uri=legit%00.evil.com`

### 3. OAuth pre-account takeover (squatting)
- Attacker registers account with victim's email (no email verification required)
- Victim later does OAuth signup with same email
- Attacker's account now has OAuth identity linked → attacker can login via password
- Test: Create account with email → link OAuth → check if pre-existing password still works

### 4. Implicit grant → token in URL fragment
- Access token in URL fragment → leaks via Referer header, browser history, logs
- Test: Check if implicit flow (`response_type=token`) is supported alongside code flow

### 5. Scope escalation
- Request more scopes than intended: `scope=admin`, `scope=openid email write:all`
- Test: Add scopes to `/authorize` request, check if granted without approval

### 6. PKCE bypass
- Remove `code_verifier` from token exchange → if token still issued, PKCE not enforced
- Test: Complete OAuth flow without sending `code_challenge` or `code_verifier`

### 7. Token reuse across clients
- Use access token from App A to access App B's API
- Test: Capture token from one OAuth client, use against different client's resource server

## JWT Attack Patterns

### Algorithm attacks
| Attack | Test | Impact |
|--------|------|--------|
| `alg: none` | Set header to `{"alg":"none"}`, empty signature | Complete auth bypass |
| RS256 → HS256 | Sign with public key as HMAC secret | Token forgery |
| Weak HMAC key | Brute-force HS256 secret (hashcat/jwt_tool) | Token forgery |

### Header injection
| Parameter | Attack | Impact |
|-----------|--------|--------|
| `kid` | Path traversal: `../../dev/null` → sign with empty | Token forgery |
| `kid` | SQLi: `key' UNION SELECT 'secret' --` | Token forgery |
| `kid` | Command injection: `key\|sleep 5` | RCE |
| `jku` | Point to attacker JWK set URL | Token forgery |
| `x5u` | Point to attacker X.509 cert URL | Token forgery |

### Claim manipulation
- Change `sub` (subject) to victim user ID → impersonation
- Change `role`/`admin`/`permissions` claims → privilege escalation
- Modify `exp` (expiry) to far future → persistent access
- Modify `aud` (audience) → access different services
- Add `email` claim → impersonate any user

### Signature validation bypass
- Remove signature entirely (keep the two dots: `header.payload.`)
- Flip single byte in signature → if accepted, validation is broken
- Send invalid Base64 in signature → check error handling

## SAML Attack Patterns

### 1. Signature wrapping
- Move the signed `<Assertion>` to a different location in the XML
- Insert malicious assertion where the original was
- Some parsers validate signature on one assertion but process another

### 2. Comment injection in NameID
- `user@evil.com<!---->@target.com` → IdP sees `user@evil.com`, SP sees `user@evil.com<!---->@target.com` which may parse to `user@target.com`

### 3. XML signature exclusion
- Remove `<Signature>` element entirely
- If SP doesn't enforce signature validation, assertion is accepted unsigned

### 4. SAML response replay
- Capture valid SAML response → replay within validity window
- Check for replay protection (InResponseTo, NotOnOrAfter)

## Session Attack Patterns

### Session fixation
- Can attacker set session ID before victim authenticates?
- Test: Set `SESSIONID=attacker_value` cookie → victim logs in → check if same session ID is now authenticated

### SameSite=None exploitation (2026 writeup pattern)
- If `SameSite=None; Secure` on session cookie → CSRF is possible from any origin on HTTPS
- Chain: CSRF on email-change/password-change/API-key-generation → 1-step ATO
- Test: Check ALL cookies, not just session cookie — middleware cookies, CSRF cookies

### Password reset token analysis
- Request 5+ tokens in sequence → check for:
  - Sequential patterns (increment by 1)
  - Timestamp-based (Unix epoch ± offset)
  - Low entropy (< 64 bits)
  - Predictable encoding (MD5/SHA1 of email+timestamp)
  - Token reuse (same token issued twice)

### Magic link / OTP bypass
- Rate limiting: send 100 OTP attempts rapidly → check if all processed
- Race condition: send correct OTP concurrently → bypass single-use check
- Token reuse: use same magic link/OTP multiple times
- Enumeration: sequential OTP codes (4-6 digits = brute-forceable without rate limit)


## 2026 Auth/OAuth/Session Techniques (newly integrated)

### Response & state manipulation
- **MFA-setup bypass via response manipulation** — During TOTP enroll, use Burp "Intercept Response" to replace the `400` error with a fake success body (e.g. `{"errorCode":"MFA_AUTHENTICATOR_ALREADY_ACTIVE"}`). Frontends that treat the API response as ground truth show MFA "enabled" while the backend has no binding ("security theater"). Generalize to any client-trusted success state (permission grants, payment, access-control).
- **Optional-parameter auth skip** — A self-service password change with signature `{id?, currentPassword?, newPassword}` has two execution paths; the `id` branch skips the current-password check → BOLA password overwrite. Treat any optional-`id` + optional-`currentPassword` as a red flag.

### OAuth / OIDC / SSO
- **`localhost` redirect_uri ATO (mobile sandbox escape)** — RPs whitelist `http://localhost:<port>` for dev; a malicious mobile app runs its own localhost listener and captures the returned `code`/`id_token`. Old flow: `response_type=id_token`, omit `prompt`. Check the RP's Google client config for localhost.
- **GSI / FedCM `auto_select` silent reauth** — New Google flow returns the token via `postMessage` validated by the `origin` query param (not redirect_uri); `auto_select`/auto-reauthentication can issue a token with no click. Test `origin` validation + auto_select.
- **"Stopping redirects" → OAuth code theft** — From XSS, read `location.search` `code`, then cancel the callback navigation (Chrome renders body when `Location:` empty; `data:` redirect no-ops at top level; dangling-markup-protection aborts URLs containing `<`+`\n`) to exfiltrate before consumption.
- **SSO account-linking persistence** — With temporary access, link an attacker SSO identity; it survives the victim's email/password reset → permanent ATO. Test whether linking re-verifies and whether credential reset unlinks.
- **Mobile WebView + deeplink OAuth hijack** — exported activity passes a `VIEW` deeplink to a weak redirect-host validator → attacker app intercepts the `code`. (when mobile app in scope)
- **Spring Authorization Server DCR (CVE-2026-22752)** — with any valid Initial Access Token, register a malicious client via Dynamic Client Registration → admin reach + SSRF via server-fetched client URIs (jwks_uri/redirect/logout). (Spring Auth Server 1.3.0–1.5.6)
- **`callbackUrl` open-redirect → XSS → ATO** — `?callbackUrl=https://target@evil.com`; when `<>` filtered, use scheme `javascript:alert(document.cookie)` to steal the session.

### WebAuthn / Passkeys
- **Non-discoverable passkey bypass (CVE-2025-26788 class)** — server doesn't bind the asserted credential ID to the username that requested the challenge: start non-discoverable auth as the victim, receive the challenge, sign with YOUR OWN registered passkey → logged in as victim. Test any WebAuthn login for credential↔username binding.

### JWT (new variants)
- Re-test "fixed" JWT/filters for variant bypasses (incomplete-fix pattern recurs in disclosed reports).

## Session: bfcache post-logout exposure
- After logout (server session invalidated; refresh → 401), pressing **Back** restores the rendered DOM with PII from the browser's back/forward cache. `Cache-Control: no-cache`/`Pragma` do NOT prevent bfcache. Test login → logout → Back. Real (P4 but valid) on shared devices / gov-PII apps; proper fix is `onpageshow`+`event.persisted`→reload.
