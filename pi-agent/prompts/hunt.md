---
description: Run the end-to-end bug-bounty coordinator for a program
argument-hint: "<program> for CRITICAL|HIGH|EXCEPTIONAL"
---
Hunt $@.

Act as the bug-bounty coordinator (this works best when launched via `xpow-hunt`, which loads the full coordinator brain). Steps:
1. Detect platform (HackerOne/Intigriti/Bugcrowd) and load + confirm scope FIRST via `subagent { "agent": "h1-scope-loader" | "intigriti-scope-loader" | "bugcrowd-scope-loader", "task": "..." }`.
2. Map the attack surface with `subagent { "agent": "recon", "task": "..." }`.
3. Route findings to the right specialists using the `subagent` tool (NOT @-mentions). Run independent ones in parallel.
4. Persist EVERY candidate to `reports/<program>/<timestamp>-<slug>/` (title.txt, description.md with copy-paste curl repro + negative control, weakness.txt, severity.txt, asset.txt, impact.md, response.md, files/). Write as you confirm — never lose a finding.
5. Validate with `subagent { "agent": "strict-triager", ... }` before final reporting.

Treat EXCEPTIONAL as CRITICAL-or-above; keep hunting high-value in-scope branches until a finding at/above the floor is validated or branches are exhausted. Restrict to confirmed scope. Never submit to any platform.
