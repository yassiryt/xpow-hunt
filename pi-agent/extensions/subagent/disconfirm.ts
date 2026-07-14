/**
 * Reflexive disconfirmation gate (Vector #1)
 * ------------------------------------------
 * The single biggest *observed* way this hunt loses criticals is FALSE-NEGATIVE
 * LOCK-IN: a specialist forms one mental model, hits a wall, records
 * "blocked / safe / not exploitable / rate-limited / by design", and commits —
 * even when its own evidence contained the disproof.
 *
 * Live proof (yahoo MAD GraphQL, 2026-06-15): a subagent saw HTTP 429, concluded
 * "rate limit", and slept 40 minutes on a strategy that could never work — while
 * a `security=NONE` federated GraphQL BOLA sat one path-encoding trick behind the
 * block. A rate-limiter is path-agnostic; only a WAF keys on the literal path.
 * The critical was behind the misdiagnosis the whole time.
 *
 * This module turns that one hand-fix into a reflex: when a subagent returns a
 * terminal-NEGATIVE verdict (and NOT a real finding), the runner automatically
 * fires ONE cheap disconfirmation pass that must (a) name >=2 alternative
 * mechanisms for the observed signal and (b) run the smallest control that
 * distinguishes them. Only if the control still says "dead" does the verdict
 * stand. Positive verdicts (validated/candidate/confirmed) are never touched.
 *
 * Pure functions here so they are unit-testable offline (see selftest.mjs).
 */

export type Verdict = "positive" | "blocked" | "negative" | "inconclusive" | "unknown";

// Strong POSITIVE markers — if present, a real finding exists; never disconfirm.
const POSITIVE_RE =
	/\b(status\s*[:=]\s*)?(validated|candidate)\b|\b(confirmed|reproduced|exploited|proof[\s-]?of[\s-]?concept|\bpoc\b|bypass(ed)?\s+(confirmed|works)|vulnerability\s+confirmed|finding\s+confirmed)\b/i;

// "I gave up / something blocked me" — the HIGHEST-value bucket to challenge
// (this is the yahoo bucket: infra excuses that are often misdiagnoses).
const BLOCKED_RE =
	/\b(status\s*[:=]\s*)?blocked\b|\b(rate[\s-]?limit(ed|ing)?|too\s+many\s+requests|\b429\b|\b403\b\s*(forbidden)?|waf\b|captcha|access\s+denied|cannot\s+proceed|can'?t\s+proceed|unable\s+to\s+proceed|gave\s+up|by\s+design|working\s+as\s+intended|out\s+of\s+scope\s+by\s+design|need(s)?\s+(valid\s+)?cred|no\s+(valid\s+)?(creds|account|token|session))\b/i;

// "I tested it and it's fine" — also worth one challenge, slightly lower value.
const SAFE_RE =
	/\b(no\s+(vulnerabilit|issue|finding|bug)|not\s+(vulnerable|exploitable|affected)|appears?\s+(secure|safe)|seems?\s+(secure|safe)|looks?\s+(secure|safe)|properly\s+(secured|validated|protected)|correctly\s+(handled|rejected|validated)|nothing\s+(exploitable|actionable)|clean\b|no\s+impact)\b/i;

// Inconclusive — coordinator already drives the follow-up; don't double up.
const INCONCLUSIVE_RE = /\b(status\s*[:=]\s*)?needs[\s-]?more[\s-]?evidence\b/i;

/**
 * Classify a subagent's final text into a coarse verdict. Positive markers win
 * over everything (a confirmed finding is never "blocked"). Then blocked beats
 * safe (an infra excuse alongside a "looks safe" is still the high-value case).
 */
export function classifyVerdict(text: string): Verdict {
	if (!text || !text.trim()) return "unknown";
	if (POSITIVE_RE.test(text)) return "positive";
	if (INCONCLUSIVE_RE.test(text)) return "inconclusive";
	if (BLOCKED_RE.test(text)) return "blocked";
	if (SAFE_RE.test(text)) return "negative";
	return "unknown";
}

/**
 * Should we auto-fire a disconfirmation pass for this verdict?
 * Only the two terminal-negative buckets. Never for positive/inconclusive/unknown
 * (unknown = the agent said something we can't classify; leave it to the parent).
 */
export function shouldDisconfirm(verdict: Verdict): boolean {
	return verdict === "blocked" || verdict === "negative";
}

/**
 * Build the disconfirmation task. Generalizes the exact reasoning that fixed the
 * yahoo misdiagnosis: enumerate alternative mechanisms for the SAME signal, then
 * run the one control that tells them apart.
 */
export function buildDisconfirmTask(originalTask: string, priorOutput: string, verdict: Verdict): string {
	const priorTail = priorOutput.length > 1200 ? priorOutput.slice(-1200) : priorOutput;
	const bucketHint =
		verdict === "blocked"
			? "You hit something that LOOKED like an infra wall (rate-limit / WAF / 403 / 'needs creds' / 'by design'). Infra walls are the #1 misdiagnosis: a 429 can be volume-throttling OR a signature/IP-reputation WAF — opposite fixes (wait vs. encode-path/rotate-egress). A '403' can be authz OR a path/method/host the WAF blocks. 'By design' is often 'by design on the canonical path only'."
			: "You concluded the surface is safe / not exploitable. Most 'clean' verdicts on a rich target are PREMATURE, not true — the bug is usually one assumption away (different identity, encoding, content-type, state order, or an adjacent endpoint that trusts the same input).";

	return [
		`DISCONFIRMATION PASS (auto-triggered by the runner — do NOT just repeat your last pass).`,
		``,
		`Your previous run on this exact objective ended with a terminal-negative verdict (${verdict}). Before that verdict is accepted, you MUST try to DISPROVE it. ${bucketHint}`,
		``,
		`Do exactly this, cheaply:`,
		`1. Re-read your own prior evidence below. Name >=2 DIFFERENT mechanisms that could produce the SAME observed signal you saw. They must imply DIFFERENT next actions.`,
		`2. Pick the single most likely alternative and run the SMALLEST control that DISTINGUISHES it from your original assumption (e.g. path-encoding variant like grap%68ql, alternate in-scope host, a second identity's token, a different Content-Type, HTTP/2 vs 1.1, or — if egress/IP-reputation is plausible — note that protonvpn egress rotation is permitted and try it).`,
		`3. If the control FLIPS the result (the "wall" was fake / the surface is reachable), pursue it now as a real finding and checkpoint it to reports/.`,
		`4. ONLY if the control still confirms the negative does the verdict stand — and then say exactly which control you ran and why it is decisive.`,
		``,
		`Hard rule: do not re-run the identical request that already failed and call it done. The control MUST differ along at least one axis (path encoding, host, identity, header, transport, egress, state). End with: status (validated/candidate/blocked/negative), the exact control you ran, and its result.`,
		``,
		`--- ORIGINAL OBJECTIVE ---`,
		originalTask,
		``,
		`--- YOUR PRIOR VERDICT (tail) ---`,
		priorTail,
	].join("\n");
}

/** Env toggle: PI_SUBAGENT_DISCONFIRM=0 disables the gate (default on). */
export function disconfirmEnabled(): boolean {
	return process.env.PI_SUBAGENT_DISCONFIRM !== "0";
}
