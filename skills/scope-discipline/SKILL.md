---
name: scope-discipline
description: "Hard scope gate for bug bounty. Keeps all recon, testing, and reporting strictly inside API-confirmed in-scope assets, enforces severity caps, and blocks out-of-scope drift. Auto-loads before any recon or active testing, before spawning any specialist, and before presenting or triaging any finding."
---

# Scope Discipline

The single most common way this hunt loses is testing or reporting something **out of scope** — reaching for an adjacent host because the in-scope surface looked dry, or claiming a finding on an asset the program never authorized. This skill makes scope a deterministic gate, not a judgment call.

**Reporting "no valid in-scope finding" honestly is a correct outcome. Testing out of scope to have something to show is a failure.**

---

## 1. THE SINGLE SOURCE OF TRUTH

Scope is defined ONLY by the API-derived files the scope loader built:

```
reports/<program>/scope/in_scope.txt
reports/<program>/scope/out_of_scope.txt
```

These are produced by `~/.pi/agent/bin/scope_build.sh` directly from the HackerOne / Intigriti / Bugcrowd platform API response. They are the sole authority.

- If those files do not exist, **you have not loaded scope** — run the scope loader (`@h1-scope-loader` / `intigriti-scope-loader` / `bugcrowd-scope-loader`) first. Never approve scope from memory, a cached summary, or a screenshot.
- The ONLY way to change scope is to re-run the loader against the API. There are no prose "scope corrections," no "authoritative" hand-edits, no "I checked and it's really in scope."
- Every subagent independently reloads and confirms scope from the platform API at the START of its run. A parent's passed scope summary is a cross-check, not authority.

## 2. THE GATE — run it before you touch or cite ANY asset

```bash
~/.pi/agent/bin/scope_check.sh reports/<program>/scope "<full-url-or-host>"
# → IN\t<matched-rule>\t<severity-cap>   → allowed, capped at that severity
# → OOS        → out of scope. DEAD. Never send a request. Never report.
# → UNLISTED   → not on any list. DEAD. Treat as OOS.
# → PATH_RESTRICTED → host allowed only on certain path prefixes; this path is NOT. DEAD.
```

Run it:
- Before the first request to any new host or endpoint.
- Before writing any host/URL into a finding, report, or the gadget ledger.
- Again at report time for the exact asset named in the finding.

If it does not print `IN`, the asset does not exist as far as the hunt is concerned.

## 3. COMPANY-OWNED ≠ IN-SCOPE (the nutaku failure)

None of the following are scope signals. They do **not** put an asset in scope:

- "It resolves in DNS."
- "It's obviously owned by the company / shares the registered domain."
- "It looks internal / like staging / like the same product."
- "It's referenced by an in-scope asset / the in-scope app calls it."
- "It was in scope on a different program or last year."

A sibling host like `gateway-api.<company>.com` that shares a parent domain with an in-scope asset is **UNLISTED → dead** unless the wildcard/rule actually matches it via `scope_check.sh`. When tempted to pivot to an adjacent asset because the in-scope surface felt dry: that temptation is the exact trigger to STOP and re-run the gate, not to rationalize.

## 4. SEVERITY IS CAPPED BY THE MATCHED RULE

The severity field returned by `scope_check.sh` is a **ceiling**, not a suggestion.

- A `*.example.com` host capped `high` cannot be reported `critical`, even if the raw impact feels critical.
- Present severity = min(demonstrated impact, scope cap). Note the cap explicitly in `severity.txt`.

## 5. WILDCARDS, APEX, PATHS, AND METHODS

- `*.example.com` matches subdomains per the program's stated depth. It does **not** automatically include the apex `example.com` unless listed. Confirm with the gate.
- A wildcard does not authorize a **different** registrable domain (`example.net`, `examplecdn.com`) even if same-company.
- Respect path-restricted scope (`example.com/api/*` in scope ≠ `example.com/admin` in scope) — that is `PATH_RESTRICTED`.
- Respect forbidden techniques from the program brief (no automated scanning, no DoS, rate limits, no social engineering, no physical, staging-only credentials, etc.). Load these into `reports/<program>/scope/rules.md` and honor them.

## 6. PRE-FLIGHT CHECKLIST (before any active batch)

- [ ] `reports/<program>/scope/{in_scope.txt,out_of_scope.txt}` exist and came from the loader/API this session.
- [ ] Target host/URL classifies `IN` via `scope_check.sh`.
- [ ] Intended technique is allowed by the program's forbidden-techniques rules.
- [ ] Request pacing respects documented rate limits (see rate-limit-pacing skill).
- [ ] The severity you plan to claim is ≤ the asset's cap.

If any box is unchecked, do not send the request.

## 7. WHEN SCOPE IS AMBIGUOUS

If the program brief is genuinely unclear (ambiguous wildcard depth, unclear whether a shared-tenant SaaS host counts, mixed signals between brief and API):
- Do NOT guess in the permissive direction.
- Pause active exploitation on that asset, record the ambiguity in `NOTES.md`, and surface it to the operator (parent agent) with the exact question. Subagents return the ambiguity + ranked next actions to the parent instead of testing on unconfirmed scope.

## DO NOT

- Send a single request to an `OOS` / `UNLISTED` / `PATH_RESTRICTED` asset "just to check."
- Report a finding whose asset does not classify `IN` at report time.
- Override the scope files with prose or memory.
- Expand scope or inflate severity to avoid an empty-handed but honest result.
