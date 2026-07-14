---
name: duplicate-and-novelty
description: "Protect payout by judging whether a finding is likely a duplicate or already-known issue, differentiating it, and framing what is genuinely novel. Covers checking prior disclosures/CVEs/changelogs, first-to-report timing, and turning a probable dup into a higher-impact variant or chain. Auto-loads before deciding whether to report a finding and while writing it up."
---

# Duplicate & Novelty

Duplicates pay nothing. Before you invest in a full report, judge how likely someone already reported this, and either sharpen what makes yours different or spend your time on something less picked-over. This is expected-value management, not discouragement.

Pairs with business-impact (a bigger-impact variant beats a common low one) and chain-patterns (chaining a common bug into something new escapes dup status).

---

## 1. DUP-RISK TRIAGE (score before writing)

Rate the finding's duplicate likelihood:

**High dup risk** (assume others found it — only report with a novel angle or clear impact):
- The first thing anyone tests: reflected XSS on the main search box, missing security headers, `/.git/` on the primary host, default creds, clickjacking, open redirect on the login `next=` param.
- A published CVE against the exact framework/version with a public PoC and no custom twist.
- Anything on the flagship domain that's trivially discoverable with a scanner.

**Low dup risk** (worth reporting):
- Requires a specific chain, a non-obvious parameter, an authenticated multi-step flow, or a specific tenant/role setup.
- On a less-trafficked in-scope asset (but still in scope), a newer endpoint, or behind a flow most testers won't reach.
- A novel bypass of an existing control, or a variant the vendor's last patch missed.

## 2. CHECK PRIOR ART (fast, before deep write-up)

- **Program disclosures / hacktivity:** has this class on this asset been publicly resolved before? Repeat patterns get dup'd.
- **Changelog / patch notes / recent commits:** was this just introduced (fresh, low-dup) or long-standing (likely found)?
- **CVE / advisory search** for the fingerprinted stack+version — if it's a known N-day, your value is proving it's exploitable *here* and unpatched, not re-describing the CVE.
- **Public write-ups** of the same program/target (Medium, X, disclosed reports) — see writeup-intel.

Treat all prior art as lead context, not proof — validate the behavior on the live in-scope target regardless.

## 3. DIFFERENTIATE / ESCALATE INSTEAD OF DROPPING

If dup risk is high but the bug is real, raise its value:
- **Chain it:** open redirect alone = likely dup; open redirect → OAuth token theft → ATO = novel and Tier-1 (chain-patterns).
- **Find the impactful variant:** reflected XSS on search (common) vs stored XSS in a profile field rendered to admins (rarer, higher).
- **Prove deeper impact:** turn "IDOR returns an ID" into "IDOR returns every user's PII, enumerable" (business-impact + safe-exploitation).
- **Move to a fresher surface:** apply the same idea to a newer/less-tested in-scope endpoint.

## 4. TIMING

- First valid report wins the bounty; later identical ones are dups. When a finding is solid and impact is proven, **report promptly** — don't sit on it while polishing.
- But do not fire off a half-proven report to "get there first"; an incomplete report gets closed and loses the slot anyway. Solid + fast beats sloppy + first or perfect + late.

## 5. REDUCE THE CHANCE YOUR OWN REPORT IS CALLED A DUP

- Be precise: exact endpoint, exact parameter, exact preconditions, exact identity/role. Specificity signals a distinct issue, not a rehash.
- State clearly what is novel (the chain, the bypass, the specific data reached) up front.
- Don't bundle five variants of the same root cause as one vague report; lead with the strongest, concrete instance.

## OUTCOME

If after this a finding is a near-certain dup with no novel angle and no path to more impact, log it to the gadget ledger and move on — your time is better spent on a lower-dup, higher-impact branch. Passing on a probable dup is a legitimate, EV-positive decision.
