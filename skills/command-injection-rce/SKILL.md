---
name: command-injection-rce
description: "OS command injection and remote code execution methodology: detect direct and blind command injection, confirm via OOB, bypass filters, and prove code execution safely without persistence or lateral movement. Auto-loads when input reaches a shell/exec sink, on file/format/ping/convert features, or when rce-hunter is engaged."
---

# Command Injection / RCE

The highest-payout class. The goal is a single, safe proof of code execution (`id`/`hostname`/an OOB callback) — never a shell, persistence, or pivoting. Deep work goes to `rce-hunter`. Payloads live in the burp-scan steering. Pairs with oob-verification (blind), safe-exploitation (stop at proof), business-impact (Critical).

---

## 1. FIND EXEC SINKS
Features that shell out or evaluate input: ping/traceroute/DNS lookup tools, file conversion/ImageMagick/ffmpeg/PDF/thumbnail, backup/export, git/SVN operations, "run"/webhook/notification, filename handling, archive extraction, template/format strings, SSTI→RCE (see server-side-injection), unsafe deserialization (see deserialization), and any admin "diagnostics" endpoint.

## 2. DETECT
- **Direct (output reflected):** append a command with separators and look for its output:
  `; id`, `| id`, `|| id`, `& id`, `&& id`, `` `id` ``, `$(id)`, newline `%0aid`. Success = `uid=NNN(name) gid=...` in the response.
- **Blind (no output):** confirm out-of-band (the reliable path):
  `; nslookup <canary>`, `| curl http://<canary>/`, `$(curl http://<canary>)`, `& ping -c1 <canary>`. A DNS/HTTP hit on your unique canary (`oob-verification`) = confirmed RCE.
- **Time-based (no OOB egress):** `; sleep 5`, `| sleep 5`, `&(timeout 5)` → repeatable ≥5s delay.
- Argument injection (not full cmd injection but still impactful): sneaking `-`/`--flags` into a program's argv (e.g. `--upload-file`, `-o`), or `$IFS` when spaces are filtered.

## 3. BYPASS FILTERS
Blocked spaces → `${IFS}`, `<`, `%09`. Blocked keywords → quotes/concatenation (`i''d`, `w\ho\ami`), variable expansion, base64-pipe (`echo <b64>|base64 -d|sh`). Blocked separators → try each of `; | & \n $() ``` and encodings. Windows variants: `&`, `|`, `%0a`, `for /f`, PowerShell `IEX`.

## 4. CONFIRM + PROVE SAFELY
- One conclusive proof: `id`/`whoami`/`hostname`/`uname -a` output in the response, OR a unique OOB callback you can show in the interaction log. That fully establishes RCE.
- Then STOP. Do NOT open a reverse shell, read secrets, install anything, persist, or move laterally — that turns a PoC into an incident (safe-exploitation stop rule). Describe how it *would* extend in `impact.md`.
- NEVER use destructive commands (`rm`, `mkfs`, `:(){ :|:& };:`, `shutdown`) even to "prove" it.
- Capture: exact request with payload, the command output or the OOB interaction log, and the injection point. Impact (business-impact): unauthenticated RCE on a production host = Critical.

## FALSE POSITIVES
- Reflected payload text that was NOT executed (the literal `; id` echoed, no `uid=`).
- A delay from a slow endpoint, not `sleep` (need repeatable deltas + control).
- A canary hit from a link-preview bot or your own browser, not the target's server (verify source IP).
- "Output" that is a canned error message mentioning your input.
