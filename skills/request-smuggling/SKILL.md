---
name: request-smuggling
description: "HTTP request smuggling / desync methodology: detect and confirm CL.TE, TE.CL, TE.TE, CL.CL, and HTTP/2 downgrade desync safely, then escalate to cache poisoning, request hijacking, and auth bypass. Auto-loads when a front-end/back-end proxy or CDN is in front of the app, when testing desync, or when request-smuggling-hunter is engaged."
---

# Request Smuggling / Desync

Desync bugs are high-payout and front-end/back-end disagreements about where one request ends and the next begins. They let you prepend attacker bytes to *other users'* requests. This is the methodology to find them without wrecking the site. Deep work goes to `request-smuggling-hunter`; confirm safely and hand off.

Pairs with oob-verification (blind desync via collaborator), safe-exploitation (never poison shared infra with real user impact), business-impact (victim-request hijack = Critical).

---

## 1. WHERE IT LIVES
Only where ≥2 HTTP processors chain: CDN/WAF → origin, LB → app, reverse proxy → backend. If there's a `Via`, `X-Cache`, `CF-RAY`, `X-Served-By`, or any proxy header, desync is in play. A single server rarely desyncs.

## 2. DETECT (timing-based, safest first)
Use the PortSwigger decision tree. Prefer **timing** detection — it doesn't poison the socket for real users.

- **CL.TE** (front-end uses Content-Length, back-end uses Transfer-Encoding):
  ```
  POST / HTTP/1.1
  Content-Length: 4
  Transfer-Encoding: chunked

  1
  A
  X
  ```
  A vulnerable back-end waits for the next chunk → response delay.
- **TE.CL**: reverse. Front-end honors TE, back-end honors CL → delay probe with a malformed chunk length.
- **TE.TE**: both support TE but one is fooled by an obfuscated header (`Transfer-Encoding: xchunked`, ` Transfer-Encoding: chunked` with leading space, `Transfer-Encoding:\tchunked`, dual TE headers).
- Use Burp's **HTTP Request Smuggler** extension to run the timing tree; treat a repeatable delay as a candidate, not proof.

## 3. HTTP/2-specific (the modern high-hit surface)
- **H2.CL / H2.TE downgrade desync**: front-end speaks HTTP/2, downgrades to HTTP/1.1 to the back-end; inject `Content-Length`/`Transfer-Encoding` in H2 pseudo/headers that survive downgrade.
- **H2 request tunnelling / CRLF in H2 header values**: smuggle `\r\n` into an H2 header name/value to split a request post-downgrade. Probe by embedding `foo: bar\r\nHost: x` and watching for a reflected/embedded second response.
- **0.CL desync** and **CL.0**: newer classes — front-end thinks body length is 0, back-end reads more (or vice versa). Test with the "single-packet" send.

## 4. CONFIRM (differential, not destructive)
- Confirm with a **self-contained** proof: smuggle a prefix that changes YOUR OWN next request (e.g. route your follow-up to a different endpoint, or make your own request 404/302 in a way the baseline doesn't). 
- For blind confirmation, smuggle a request to an OOB canary (`oob-verification`) or to an internal-only path and observe the differential.
- A confirmed desync = the back-end attributes your smuggled bytes to a *different* connection/request.

## 5. ESCALATE (impact) — carefully
- **Cache poisoning** via desync: smuggle a request whose response gets cached against a victim path → mass impact. Prove on a benign/unique path you control; do NOT poison a real high-traffic page for real users.
- **Capture another user's request** (request hijacking): smuggle a prefix that appends the next visitor's request to a location you can read (e.g. into a comment/search you can retrieve). Prove with your OWN second connection as the "victim," not a real user.
- **Bypass front-end controls**: reach back-end-only paths (`/admin`, internal headers the front-end strips) by smuggling past the proxy.
- **Auth/rewrite bypass**: front-end adds trust headers (`X-SSL`, `X-Internal`) the back-end trusts — smuggle to forge them.

## 6. SAFETY + EVIDENCE
- Desync PoCs can affect OTHER users of the same socket/cache. Use your own connections and unique/benign paths; never capture real users' data or poison shared cached pages (safe-exploitation stop rules). One clean self-hijack proves it.
- Capture the exact smuggled request bytes (raw, CRLF-accurate) + the differential response to `files/`. Note front-end/back-end software from headers.
- Impact framing (business-impact): mass request hijack / cache poisoning across users = Critical; front-end control bypass = High.

## DEAD-ENDS / FALSE POSITIVES
- Network jitter mimics timing delays — require repeatable deltas across trials.
- A WAF normalizing headers can look like a fixed desync; verify the differential is the app, not the edge.
- Load balancers with connection-per-request (no reuse) blunt real-world impact — note it in severity.
