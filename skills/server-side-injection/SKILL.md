---
name: server-side-injection
description: "Server-side injection family beyond SQL: SSTI, XXE, NoSQL, LDAP, and XPath injection — detection markers, engine fingerprinting, and safe escalation to RCE/file-read/auth-bypass. Auto-loads on template rendering, XML parsing, NoSQL/LDAP queries, or when injection-hunter is engaged."
---

# Server-Side Injection (SSTI / XXE / NoSQL / LDAP / XPath)

The injection classes that aren't SQL. Each has a cheap, unambiguous detection probe; escalation follows once the engine is fingerprinted. Deep work goes to `injection-hunter`. Payloads live in the burp-scan steering. Pairs with oob-verification (blind XXE/SSTI), safe-exploitation, business-impact.

---

## SSTI (Server-Side Template Injection)
- **Detect** with a math marker that only evaluates if templated (avoid `7*7`=49 false positives): `{{1337*73}}`→`97601`, `${1337*73}`, `<%= 1337*73 %>`, `#{1337*73}`, `*{1337*73}`. The marker rendering = confirmed.
- **Fingerprint the engine** from which syntax fires + error style: Jinja2/Twig (`{{ }}`), Freemarker/Velocity, Thymeleaf (`#{}`/`*{}`), ERB (`<%= %>`), Handlebars, Pug, Smarty. `{{7*'7'}}`→`7777777` = Jinja2.
- **Escalate to RCE** with the engine-specific object path (Jinja2 `{{cycler.__init__.__globals__.os.popen('id').read()}}`, Freemarker `?new()`, etc.). Confirm blind via OOB callback (`oob-verification`). Prove with `id`, then stop (safe-exploitation).
- **Second-order:** inject into a stored field (name, profile) that a later template renders — read the confirmation email/PDF for the evaluated marker.

## XXE (XML External Entity)
- **Where:** any XML input — SOAP, SAML, RSS/Atom import, SVG/DOCX/XLSX upload, `Content-Type: application/xml`, or JSON endpoints that also accept XML (switch the content type).
- **Classic file read:** `<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>` → `root:x:0:0`.
- **SSRF via XXE:** point the entity at an internal URL / cloud metadata (→ ssrf-exploitation).
- **Blind / OOB:** external parameter-entity DTD hosted on your canary to exfil or just to prove resolution (`oob-verification`); error-based to leak file contents via a parse error.
- Note billion-laughs/entity-expansion is DoS — do NOT run it (safe-exploitation).

## NoSQL Injection (MongoDB et al.)
- **Auth bypass / operator injection:** JSON `{"user":"admin","pass":{"$ne":null}}`, `{"$gt":""}`; in query strings `user[$ne]=x`. `$regex`, `$where` (JS eval), `$gt/$lt` for blind boolean extraction.
- Detect via differential (operator changes result set) exactly like boolean SQLi. `$where`/`$function` can reach JS execution on some setups.

## LDAP Injection
- Inputs into LDAP filters (login, user search): `*`, `*)(uid=*))(|(uid=*`, `admin)(&))`. A `*` returning all users or an auth bypass = confirmed. Watch for filter-syntax errors as the signal.

## XPath Injection
- Inputs into XPath (XML-backed login/search): `' or '1'='1`, `x' or 1=1 or 'x'='y`, `*[position()=1]`. Blind boolean/substring extraction of the XML doc, analogous to blind SQLi.

## CONFIRM + IMPACT (all classes)
- Prove the CONSEQUENCE: the evaluated math marker (SSTI), the file content (XXE), the auth bypass or extracted field (NoSQL/LDAP/XPath), or the OOB callback for blind cases. A reflected-but-not-evaluated payload is not a finding (evidence-discipline).
- Impact (business-impact): SSTI/XXE→RCE or file-read/SSRF = High/Critical; NoSQL/LDAP/XPath auth-bypass or data extraction = High. Prove safely, read one proof value, redact secrets.

## FALSE POSITIVES
- `97601`/`49` appearing in legitimate content (product id, timestamp) — require it to appear ONLY when the template expression is sent.
- Literal `{{1337*73}}` reflected unevaluated = not SSTI.
- XML accepted but entities disabled (no resolution) = hardened; don't claim XXE without the entity resolving.
