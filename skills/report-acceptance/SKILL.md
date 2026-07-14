---
name: report-acceptance
description: "Write bug bounty reports that a human triager accepts fast, in plain human language with no AI tells, marketing tone, or filler. Covers the minimal structure triagers want, copy-paste reproducibility, and avoiding duplicate/informational/not-applicable/need-more-info closures. Auto-loads when writing description.md or any finding report, and before final submission handoff."
---

# Report Acceptance

A report gets accepted when a busy triager can reproduce it in two minutes and immediately sees the impact. Write for that person. Everything else is noise.

Pairs with finding-reporter (folder scaffolding), business-impact (the impact section), evidence-discipline (only proven claims), duplicate-and-novelty (don't get dup'd).

---

## WRITE LIKE A HUMAN — this is the point

The report must read like a working pentester wrote it, not a chatbot. Strip the AI tells:

- **No preamble or wind-up.** Don't write "In this report, we will demonstrate..." or "This vulnerability is a critical security issue that...". Start with what it is.
- **No filler phrases:** cut "It is important to note that", "As we can see", "It's worth mentioning", "In conclusion", "Overall", "Furthermore", "Additionally". Just say the thing.
- **No marketing / scare tone.** Don't sell severity with adjectives ("devastating", "catastrophic", "highly critical"). Facts carry the weight.
- **Plain words.** Short sentences. Active voice ("The server returns User B's email" not "It can be observed that the email of User B is returned by the server").
- **No decorative structure.** Don't bold every other word, don't nest bullets three deep, don't add headings for one-line sections, no emoji, no horizontal-rule art. A couple of clear sections and a numbered repro is enough.
- **Don't over-explain the obvious.** A triager knows what a cookie is. Explain what's specific to *this* bug, not web basics.
- **Don't repeat yourself.** Say each fact once. The impact goes in the impact section, not also in the intro and the summary and the conclusion.
- **No hedging.** If you proved it, state it. If you didn't, don't include it. Drop "may possibly potentially".

Rule of thumb: if a sentence doesn't help reproduce the bug or understand its impact, delete it. Shorter and clearer wins.

## STRUCTURE (only what a triager needs)

Keep `description.md` to these parts, in this order:

1. **One line:** what it is + where + the impact. e.g. "IDOR in `GET /api/orders/{id}` lets any logged-in user read any other user's order, including name, address, and items."
2. **Steps to reproduce:** numbered, copy-paste. Real URLs, real headers, real bodies (or the exact test values you used). Include the expected result after the key steps so they know what "worked" looks like.
3. **Proof:** the actual request/response (redacted) or a screenshot, referenced from `files/`. Show the difference between the normal case and the attack.
4. **Impact:** one short paragraph — who can do what, to whom, at what scale (from business-impact). No worst-case fantasy; what you proved.
5. **Fix:** one or two concrete sentences. Signals good faith, speeds triage.

That's it. No "Executive Summary", no "Table of Contents", no "Disclaimer", no restating the program's own policy back at them.

## MAKE IT REPRODUCIBLE (the thing that actually gets it accepted)

- Self-contained: every step present, no "see above", no placeholders. If it needs a test account, include the login for the accounts you created.
- Exact `curl` commands with the real endpoint, headers, and body.
- State what to look for in the response (the specific field/status/marker that proves it).
- Include one negative control (the benign request that behaves differently) so they see it's a real control failure, not normal behavior.

## AVOID THE COMMON CLOSURES

- **Duplicate:** be specific and lead with what's distinct (see duplicate-and-novelty).
- **Informational / no impact:** show real, proven impact — don't submit a bare "missing header" or a self-XSS. If the validity gate would reject it, don't send it.
- **Not applicable / out of scope:** confirm the asset is IN scope at report time (scope-discipline) and name the matched scope entry.
- **Need more info:** pre-empt it — full repro, versions, timestamps, account details, and the raw evidence all included the first time.

## BEFORE HANDOFF — quick self-check

- [ ] Could someone reproduce this with only what's in the report? (No missing step, no placeholder.)
- [ ] Is the impact proven, not asserted, and severity reconciled to it + capped by scope?
- [ ] Did I cut every sentence that isn't repro or impact?
- [ ] Does it read like a person wrote it — plain, direct, no AI filler or decoration?
- [ ] Asset confirmed in scope; secrets/PII redacted in the evidence.
