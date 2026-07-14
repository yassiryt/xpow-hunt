---
name: race-conditions
description: "Race condition / TOCTOU methodology: find and prove limit-overrun, state-machine, and time-of-check-to-time-of-use races using single-packet and last-byte-sync techniques. Auto-loads when testing money/credit/coupon/invite/withdrawal flows, one-time actions, or when race-condition-hunter is engaged."
---

# Race Conditions

Races turn "you may do X once" into "you did X twenty times." They hide in any check-then-act flow with shared state. High payout when they hit money, entitlements, or limits. Deep work goes to `race-condition-hunter`; use this to spot and prove them.

Pairs with safe-exploitation (use your own account/funds, minimal repetitions), business-impact (double-spend/limit-bypass = High/Critical).

---

## 1. WHERE TO LOOK (limited-quantity or one-time actions)
- **Money/credit:** apply a coupon/gift card/referral bonus N times; withdraw/transfer the same balance twice; checkout at an old price.
- **Entitlements/limits:** exceed "one vote/like/claim per user", invite past a seat cap, redeem a single-use token twice, over-draw a rate/quota.
- **State machine:** submit + cancel simultaneously; approve + delete; verify email while changing it; 2FA enable/disable races.
- **Account:** register the same username/email twice; consume a single-use reset token in parallel.

## 2. THE TECHNIQUE (make requests arrive truly simultaneously)
The window is often microseconds — you must remove network jitter:
- **HTTP/2 single-packet attack**: send 20–30 requests in ONE TCP packet (Burp Repeater "Send group in parallel" / Turbo Intruder `engine=Engine.BURP2`). This neutralizes jitter and is the modern default.
- **HTTP/1.1 last-byte synchronization**: send all requests but withhold the final byte of each, then release them together (Turbo Intruder `gate`).
- Fire the SAME action concurrently; compare the post-state to the single-request baseline.

## 3. CONFIRM
- Baseline: perform the action once → note the legitimate result (balance −$10 once, 1 coupon applied).
- Race: fire the batch → if the effect applied more times than allowed (balance −$10 but credited ×5, coupon stacked ×5, 6 seats from a 5-seat cap), the race is confirmed.
- Require a **clear differential** vs baseline; a single extra success is enough — don't loop for volume (safe-exploitation).
- Rule out idempotency keys / DB unique constraints that silently dedupe (that's the fix working).

## 4. ESCALATE / IMPACT
- Quantify: "single-use referral credit redeemed N times = $X free credit," "withdrawal of $B executed twice = double-spend," "seat/quota cap bypassed."
- Chain: race a coupon to negative totals (→ price manipulation), race email-change vs verification (→ ATO), race invite acceptance (→ cross-tenant).
- Severity (business-impact): financial double-spend or entitlement bypass with real money = High/Critical; benign limit overrun = Medium.

## 5. SAFETY + EVIDENCE
- Use YOUR OWN accounts and the smallest amounts; immediately reverse/withdraw test value where possible; never touch real balances (safe-exploitation).
- Capture: the parallel-send config, the batch of responses showing multiple successes, and the resulting state (balance/count) vs the single-request baseline. Screenshot the post-state.

## FALSE POSITIVES
- Multiple 200s but the backend only applied the action once (check the actual state/balance, not just response codes) — NOT a race.
- Client-side-only counters; the server enforced the limit — NOT a finding.
- "Success" responses that are actually queued/pending and later rejected — verify final committed state.
