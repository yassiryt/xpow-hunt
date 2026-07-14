---
name: business-impact
description: "Translate a technical vulnerability into concrete business risk and a defensible severity so reports get accepted and paid at the right tier. Covers impact articulation, CVSS v3.1/v4.0 + Bugcrowd VRT + HackerOne severity mapping, realistic attacker modeling, and bounty-optimized framing. Auto-loads when writing impact.md or severity.txt, when scoring or arguing severity, and when deciding which finding to report first."
---

# Business Impact

Programs pay for **demonstrated business risk**, not vulnerability class names. The same technical bug can be a $50 "informational" or a $20k critical depending entirely on the impact you prove and how you frame it. This skill turns "I found a bug" into "here is what an attacker can do to your business, and here is the proof."

Pairs with **evidence-discipline** (never claim impact you didn't prove) and **scope-discipline** (severity is capped by the matched scope rule). Writes the finding folder's `impact.md` and `severity.txt`.

---

## 1. THE IMPACT QUESTION

For every finding, answer in one sentence a non-technical program owner would understand:

> "An attacker who is **[who]** can **[do what]** to **[whose data / which system]**, resulting in **[business consequence]**."

If you cannot fill every bracket from OBSERVED evidence, you do not yet have the impact — go prove the missing bracket (see safe-exploitation for how to prove it without harm).

Bad: "Reflected XSS on /search."
Good: "An unauthenticated attacker can run JavaScript in any logged-in user's session via a crafted /search link, letting them steal session cookies and take over accounts, including admin accounts that manage all customer data."

## 2. MAP TECHNICAL → BUSINESS CONSEQUENCE

Translate the primitive into the categories programs actually care about:

| Business consequence | Triggers |
|---|---|
| **Unauthorized data access / breach** | IDOR/BOLA, SQLi, SSRF-to-internal, path traversal, exposed backups. Quantify: whose data, how many records, what fields (PII, payment, health, creds). |
| **Financial loss / fraud** | Price/quantity manipulation, payment bypass, coupon/refund abuse, balance tampering, race-condition double-spend. |
| **Account takeover / impersonation** | Auth bypass, stored XSS on authenticated pages, OAuth/JWT flaws, password-reset flaws. State the victim reach (any user? admin? all users?). |
| **Privilege escalation / admin compromise** | BFLA, vertical BAC, mass assignment (`role=admin`), SSRF to metadata → cloud creds. |
| **Integrity / RCE / system compromise** | RCE, deserialization, request smuggling poisoning other users, cache poisoning. Highest tier — full control. |
| **Compliance / regulatory exposure** | PII/PHI/PCI exposure → GDPR, HIPAA, PCI-DSS implications. Name the regime when the data type triggers it. |
| **Reputational / trust** | Defacement, content injection served to all users, leaked internal comms. |

## 3. QUANTIFY — scale is the multiplier

Severity scales with blast radius. Always state:
- **Reach:** one user (self) vs. any single targeted user vs. ALL users vs. admins/all-tenants. Cross-user/cross-tenant/admin reach is what turns medium into critical.
- **Volume:** one record vs. enumerable at scale (sequential IDs, no rate limit) vs. entire table/bucket.
- **Data sensitivity:** public < internal < PII < credentials/payment/health.
- **Preconditions:** unauthenticated > any-authenticated > same-tenant > needs-victim-interaction. Fewer/weaker preconditions = higher severity. (If a precondition assumes you already hold the victim's session, evidence-discipline's gate rejects the ATO claim entirely.)

## 4. SCORE SEVERITY DEFENSIBLY

Give the program a severity they can't argue down, aligned to demonstrated impact (never inflated):

- **CVSS v3.1 vector** — always provide the full vector string (e.g. `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N`), not just the number. Justify each metric from evidence. Use `S:C` (scope changed) only when you actually cross a security boundary.
- **CVSS v4.0** — add when the program uses it; it better captures scope and Attack Requirements.
- **Bugcrowd VRT** — map to the P1–P5 taxonomy when the program is Bugcrowd (VRT priority often overrides CVSS for payout).
- **HackerOne severity** — Critical / High / Medium / Low; ensure your CVSS band matches your narrative.
- **Reconcile:** demonstrated impact, CVSS band, and program rubric must agree. If they don't, your narrative or your score is wrong — fix it, don't hand-wave. Then apply the **scope severity cap**: never present above the matched scope rule's ceiling.

Write the final call + vector + rationale into `severity.txt`.

## 5. REALISTIC ATTACKER MODEL

Triagers reject "theoretical" impact. Show a plausible attacker and a plausible path:
- Who realistically holds the required position (anonymous internet user? any signed-up user? a low-priv employee?).
- A believable delivery (a link they'd click, a normal API call, a public form).
- Why the preconditions are attainable in the real product, not just a lab.
- If a chain is required, show each link is independently plausible (see chain-patterns) — a chain reaching Tier-1 impact IS a Tier-1 finding even if the components are individually low.

## 6. BOUNTY-OPTIMIZED FRAMING (for impact.md)

- **Lead with impact, not mechanism.** First line = worst realistic business outcome, proven.
- **Quantify early:** "exposes the PII of all ~N users" beats "exposes user data."
- **Name the crown-jewel reach:** admin, payments, all-tenants, credentials — programs price on this.
- **Tie to their business:** a payment bug on a fintech, PII on a healthcare app, tenant isolation on a B2B SaaS — say why it matters to *this* company.
- **Show, don't assert:** reference the exact evidence in `files/` (redacted). Impact you merely assert gets downgraded.
- **State remediation briefly** — signals good faith and speeds acceptance.
- **Don't overreach:** one proven critical beats three inflated highs. Inflation gets you closed as "not applicable" and hurts signal.

## 7. PRIORITIZE WHAT TO REPORT / HUNT FIRST (expected value)

Rank by expected bounty = (probability accepted) × (payout at demonstrated severity):
- **Tier 1 first:** RCE, auth bypass/ATO with broad reach, high-impact SSRF (cloud creds/internal), request-smuggling, payment/business-logic abuse, cross-tenant breaks.
- **Tier 2:** IDOR/BOLA with sensitive read/write, traversal/LFI to high-value files, privilege escalation.
- **Tier 3:** XSS/SQLi/medium classes — unless they chain to ATO/data theft/admin, which promotes them.

## IMPACT ANTI-PATTERNS (don't do these)

- Claiming worst-case impact you didn't demonstrate ("could lead to RCE" with no PoC).
- Severity inflation to chase payout — reconcile to evidence and the scope cap instead.
- Impact that presupposes attacker already has victim creds/session (rejected by the validity gate).
- Calling public-by-design keys/data "high impact."
- Vague "sensitive data" with no field names, no record count, no reach.
