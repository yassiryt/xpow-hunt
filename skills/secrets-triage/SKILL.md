---
name: secrets-triage
description: "Decide whether a discovered key/token/secret is a real, privileged, reportable finding or a public-by-design value with no impact. Covers per-provider classification, minimal non-destructive validation, privilege/scope determination, and impact framing. Auto-loads whenever a secret, API key, token, or credential is found in JS, responses, git history, backups, or config."
---

# Secrets Triage

Finding a "key" is not a finding. Half of what looks like a secret is meant to ship publicly; reporting those gets you closed as informational and hurts your signal. The job is to classify the secret, prove (minimally) whether it's live and privileged, and only then report — framed by what it actually unlocks.

Pairs with evidence-discipline (the validity gate auto-rejects public-by-design secrets) and safe-exploitation (validate the least-invasive way, then stop).

---

## 1. PUBLIC-BY-DESIGN — NOT a finding on its own

These are meant to be in client code / responses. Do not report them as secrets absent proven privileged impact:
- OAuth **client_id** and (for public clients) consumer keys
- Firebase `apiKey`, `authDomain`, `databaseURL` (identity config, not a secret — test Firestore/RTDB **rules** instead)
- Google Maps / Analytics / reCAPTCHA site keys (`AIza...` used browser-side)
- Sentry DSN, Segment write key, Intercom/Mixpanel app id
- Stripe **publishable** key `pk_live_` / `pk_test_`
- Algolia **search-only** key, PlayFab title id, Branch/AppsFlyer keys

The finding, if any, is what the *configuration* allows (e.g. world-readable Firestore rules), not the key itself.

## 2. POTENTIALLY PRIVILEGED — validate before reporting

These can be real and serious. Validate with ONE minimal, non-destructive call, then stop:
- **AWS** `AKIA...` + secret → `aws sts get-caller-identity` (identity only; never enumerate/read data beyond that).
- **Stripe secret** `sk_live_` / `rk_live_` → a single read-only `GET /v1/account` (never move money).
- **GitHub** `ghp_` / `github_pat_` / `gho_` → `GET /user` and token scopes header (don't touch repos).
- **Slack** `xoxb-`/`xoxp-` → `auth.test` (don't post).
- **GCP service-account JSON** → token introspection / a single read-only metadata call.
- **Azure** connection strings / SAS tokens → a single list/metadata call.
- **Twilio** `AC...`+auth, **SendGrid** `SG.`, **Mailgun** → read-only account/profile endpoint.
- **Private keys** (`-----BEGIN ... PRIVATE KEY-----`), DB connection strings, JWT signing secrets, `sk-` LLM keys → confirm format/scope; prove validity the least-invasive way possible.

Rule: prove the key is **live** and learn its **privilege/scope** — nothing more. One `whoami`-class call is the proof; enumerating or reading real data crosses into safe-exploitation's stop-and-report line.

## 3. WHERE IT CAME FROM CHANGES EVERYTHING

- **In front-end JS / mobile bundle:** assume public unless it's a confidential key that leaked there by mistake (a server secret in client code IS a finding).
- **In a server response, error, backup (`.env`, `.sql`, `.bak`), or `.git` history:** far more likely a real leak — check git history even if the current file is clean (`git log -p | grep -iE 'secret|key|token|password'`).
- **Scope check the host** it was found on and the service it unlocks — a valid key to a third-party/non-program service may have no impact on the program (validity gate).

## 4. IMPACT FRAMING

Severity = what the key unlocks, proven:
- Read/write to production data, PII, or other tenants → High/Critical.
- Send email/SMS as the company (phishing), post as the company, or spend money → High.
- Read-only access to non-sensitive metadata → Low/Medium.
- Expired/revoked/sandbox-only key → informational (state you validated and it was inactive).

Redact the secret in the report (`AKIA****`, `sk_live_****`), record where it was found and what the validation call returned (masked), and never retain the raw value. Route to business-impact for scoring.

## DO NOT

- Report a Firebase `apiKey` / publishable `pk_` / client_id as a "leaked secret."
- Use a validated key to pivot, read real user data, or move money "to show impact" — validity + scope is the proof; the rest is an incident.
- Keep or paste live secret values in reports or memory.
