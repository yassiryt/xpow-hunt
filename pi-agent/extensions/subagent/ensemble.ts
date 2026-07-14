/**
 * Ensemble + Swarm task builders
 * ------------------------------
 * These turn high-level "find more bugs" intents into concrete subagent task
 * lists that run through the existing concurrency-limited, RAM-gated parallel
 * runner.
 *
 * ENSEMBLE (#2 — rediscovery via non-determinism):
 *   The coordinator brain already states: "Non-determinism means each pass
 *   catches different bugs." Ensemble institutionalizes that — it runs the SAME
 *   specialist K times on ONE high-value surface, each pass nudged down a
 *   genuinely different angle (entry point, parameter set, payload family, auth
 *   state, transport). The K results come back labeled; the coordinator merges
 *   and dedupes them (semantic merge needs an LLM, so we do NOT dedupe in code —
 *   we hand all passes back and the workflow routes the merge to
 *   security-analyzer). Best aimed at auth/payment/admin/AI surfaces where a
 *   missed bug is an EXCEPTIONAL bug.
 *
 * SWARM (#1 — exhaustive surface coverage):
 *   Instead of the coordinator hand-picking 3-4 leads, swarm drains a full list
 *   of {agent, task} cells (e.g. the surface x vuln-class matrix built from recon
 *   artifacts) through the runner. The RAM gate + concurrency cap throttle it so
 *   a 200-cell queue drains safely over time on a small box rather than thrashing.
 */

export interface BuiltTask {
	agent: string;
	task: string;
	cwd?: string;
}

// Default "angle" hints cycled across ensemble passes when the caller does not
// supply explicit variants. Each is a DIFFERENT track, not a retry — that is the
// whole point (a plain retry catches the same bugs).
export const DEFAULT_ENSEMBLE_ANGLES: string[] = [
	"PASS A — primary/likely path: hit the most obvious exploitable behavior head-on with standard payloads for this class.",
	"PASS B — different entry points & parameters: target alternate endpoints, hidden/secondary params, JSON vs form vs query, and array/object param shapes you did NOT try in pass A.",
	"PASS C — different payload family & encoding: switch encodings, parser confusion, alternate metacharacters, and a different exploitation primitive for the same class.",
	"PASS D — auth-state & role variation: re-run as a different role/tenant, unauthenticated, expired/again-issued tokens, and cross-account object references.",
	"PASS E — transport & protocol variation: HTTP/1 vs HTTP/2, multipart vs raw, header smuggling/casing, content-type mismatch, websocket/SSE where present.",
	"PASS F — state & timing variation: out-of-order steps, partial/incomplete flows, concurrency/race on the same operation, and replay of one-time actions.",
	"PASS G — boundary & malformed inputs: oversized, empty, null-byte, unicode/normalization, contradictory fields, and wrong-state requests (negative-path).",
	"PASS H — chain-seeking: assume one low-severity primitive here is real and aggressively look for the gadget that escalates it to ATO/RCE/data theft.",
];

const SHARED_ENSEMBLE_FOOTER =
	"This is one pass of a multi-pass ENSEMBLE on the same surface. Stay strictly on YOUR assigned angle above so passes do not overlap. " +
	"Checkpoint findings to `reports/<program>/...` as you go and END with a plain-text structured summary — if you end on a tool call or run out of turns you return nothing and your work is lost.";

/**
 * Build K ensemble tasks for one agent on one base task. Each pass gets a
 * distinct angle directive appended. `variants` (if provided) overrides the
 * default angle pool and also sets the pass count to variants.length.
 */
export function buildEnsembleTasks(
	agent: string,
	baseTask: string,
	passes: number,
	variants: string[] | undefined,
	cwd: string | undefined,
): BuiltTask[] {
	const angles = variants && variants.length > 0 ? variants : DEFAULT_ENSEMBLE_ANGLES;
	const k = variants && variants.length > 0 ? variants.length : Math.max(1, passes);
	const out: BuiltTask[] = [];
	for (let i = 0; i < k; i++) {
		const angle = angles[i % angles.length];
		const label = `[ensemble pass ${i + 1}/${k}]`;
		out.push({
			agent,
			task: `${label}\n\n${baseTask}\n\n--- ANGLE FOR THIS PASS ---\n${angle}\n\n${SHARED_ENSEMBLE_FOOTER}`,
			cwd,
		});
	}
	return out;
}

/**
 * Normalize a swarm task list. Validates each cell has agent + task, trims, and
 * caps the count (caller enforces the numeric cap; this only shapes/validates).
 * Returns { tasks, errors }.
 */
export function buildSwarmTasks(
	cells: Array<{ agent?: string; task?: string; cwd?: string }> | undefined,
): { tasks: BuiltTask[]; errors: string[] } {
	const tasks: BuiltTask[] = [];
	const errors: string[] = [];
	if (!cells || cells.length === 0) {
		errors.push("swarm.tasks is empty");
		return { tasks, errors };
	}
	for (let i = 0; i < cells.length; i++) {
		const c = cells[i];
		const agent = (c.agent || "").trim();
		const task = (c.task || "").trim();
		if (!agent || !task) {
			errors.push(`swarm cell ${i + 1} missing ${!agent ? "agent" : "task"}`);
			continue;
		}
		tasks.push({ agent, task, cwd: c.cwd });
	}
	return { tasks, errors };
}
