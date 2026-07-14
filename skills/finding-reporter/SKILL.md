---
name: finding-reporter
description: "Triage-ready evidence and reporting pipeline for bug bounty findings. Scaffolds reports/<program>/<timestamp>-<slug>/ with all required field files and standardizes auto-PoC capture (raw HTTP via Burp, screenshots via browser-live, copy-paste curl repro + negative control). Auto-loads when documenting a candidate finding or before triage."
---

# Finding Reporter

Turn a confirmed lead into a self-contained, triage-ready artifact folder — fast, and without losing evidence to compaction.

## When to use
The moment you have a CANDIDATE finding (not every probe). Scaffold the folder FIRST, then fill it as you confirm. Never hold a decisive result only in chat context.

## One-command scaffold
The `new-finding` script is on the pi agent's PATH (`~/.pi/agent/bin/`):

```bash
new-finding <program> <slug> [severity] [weakness] [asset]
# example:
new-finding acme idor-invoice-read high "CWE-639 IDOR" https://acme.com/api/invoices/123
# -> prints: reports/acme/20260627-094501-idor-invoice-read
```

It creates `reports/<program>/<UTC-timestamp>-<slug>/` containing:
`title.txt`, `description.md`, `weakness.txt`, `severity.txt`, `asset.txt`, `impact.md`, `response.md`, and `files/`.

## What each field file must contain
| File | Content |
|---|---|
| `title.txt` | One clear human title (no jargon dump). |
| `description.md` | 100% self-contained, copy-paste reproducible: exact requests/URLs/headers/params, execution order, expected output per step, and at least one negative control. |
| `weakness.txt` | Weakness class / CWE (e.g. `CWE-639 IDOR`, `SSRF`, `JWT alg-confusion`). |
| `severity.txt` | `critical`/`high`/`medium`/`low`/`info` — match demonstrated impact, do not inflate. |
| `asset.txt` | Exact in-scope asset/endpoint. |
| `impact.md` | What an attacker achieves + a realistic end-to-end scenario. |
| `response.md` | Triager verdict block (filled by `@strict-triager`). |
| `files/` | Raw request/response pairs, screenshots, decisive excerpts. |

## Auto-PoC capture
- **Raw HTTP**: save the exact request+response that proves it to `files/` as `NN-step-request.txt` / `NN-step-response.txt` (pull from Burp). Keep the baseline AND the attack pair.
- **Screenshots**: for client-side / visual proof (XSS exec, rendered DOM, UI state) use browser-live `take_screenshot` into `files/`.
- **curl repro**: every step in `description.md` is copy-paste runnable, includes auth, and states expected output.
- **Negative control**: include at least one request that SHOULD fail (wrong role / removed flaw / invalid id) and show it denied — this is what separates a real finding from noise.
- **First-party creds**: if repro needs test accounts/tokens/cookies/invite links created during the hunt, include the EXACT values and label them clearly so a triager can run the steps without rebuilding setup.

## Quality bar before handing to @strict-triager
- `description.md` reproducible from a clean machine.
- At least one decisive artifact in `files/`.
- Severity matches proven impact.
- Memory MCP finding key refreshed: `<program>|<asset>|<weakness>|<auth-state>|<surface>` with status + artifact path.

## Checkpoint discipline
Write evidence as you go and refresh the Memory key incrementally. A folder with partial real evidence always beats a perfect finding lost to a crash, step cap, or compaction.
