---
name: rate-limit-pacing
description: "Respectful request pacing that keeps automated testing within a program's documented rate limits — safe RPS/concurrency, jitter, and 429/Retry-After backoff. This is staying within the rules, NOT ban/WAF evasion. Auto-loads before any high-volume tool pass (nuclei, ffuf, katana, intruder, httpx)."
---

# Rate-Limit Pacing

Keep automated passes inside the program's stated limits so testing is sustainable and findings stay valid.

## Principle (read first)
This is pacing, **not evasion**. We slow down to respect the target's documented limits. We do NOT rotate IPs/identities to dodge bans, spoof fingerprints, or bypass anti-abuse/WAF controls. If a target blocks you at its documented limit, slow down or request a testing window / allowlist from the program — never try to evade. Evasion violates program rules and invalidates findings.

## Before any high-volume pass
1. Read the program rules for an explicit cap (req/sec, req/min, concurrency, or "no automated scanning"). If automated scanning is forbidden, do NOT run nuclei/ffuf — switch to targeted manual testing in Burp.
2. If no explicit cap is published, default conservative: **<= 5 rps per host**, **concurrency <= 10**, and watch for latency/error degradation.

## Apply the cap (tool flags)
- **nuclei**: `-rl <rps> -c <concurrency> -timeout 10` (use `-rld` for per-host rate if supported)
- **ffuf**: `-rate <rps> -t <threads> -p 0.1-0.3` (random per-request delay)
- **katana**: `-rl <rps> -c <concurrency> -delay <ms>`
- **httpx**: `-rl <rps> -threads <n>`
- **Burp Intruder**: resource-pool throttle or fixed delay between requests.

## Adaptive backoff (mandatory)
- On HTTP **429** or **503**: STOP, read `Retry-After`, sleep that long (or exponential backoff `2^n` seconds with jitter, capped ~2 min), then resume at **half** the previous rate.
- On rising latency or error rate: halve concurrency. Never ramp past the cap.
- Add **10–30% random jitter** between requests so load is smooth rather than lock-step bursts (gentler on the target — this is courtesy, not stealth).

## Account / access safety (legitimate)
- Use only first-party test accounts created via `@test-account-manager`.
- If a test account or your IP gets blocked at the documented limit, pause and request allowlisting or a testing window from the program. That is the correct, in-rules fix — not an obstacle to evade.
