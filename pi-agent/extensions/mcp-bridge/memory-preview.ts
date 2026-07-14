/**
 * Memory search-result slimming (context-bloat control)
 * -----------------------------------------------------
 * WHY: measured from 51 real hunt logs, the stock memory server's `search_nodes`
 * is a dumb case-insensitive substring filter that returns the FULL matching
 * entities (every observation) across ALL programs in one global store. On
 * mature programs that means a single fuzzy search dumped 19k-24k tokens of
 * mostly-other-program history into context (median search = 9 tokens / empty,
 * but the p90 tail = ~10k and the max = ~24k). That tail is the real
 * "smartness-decreasement via context bloat" risk.
 *
 * The intended pattern (per the prompts) is: search = cheap INDEX to find the
 * right keys, then open_nodes = full DETAIL on the chosen key. But agents fire
 * 264 fuzzy search_nodes vs only 12 keyed open_nodes — they ignore the rule.
 *
 * FIX (structural, not a nag): transform ONLY `memory:search_nodes` results into
 * a compact PREVIEW — per entity: name, type, observation count, and a small
 * char-budgeted snippet of the first observation(s) — plus a footer telling the
 * model to `open_nodes "<name>"` for the full entity. `open_nodes` is left at
 * full fidelity, so the cheap path becomes the natural one: search to locate,
 * open to read. read_graph stays denied. Writes are untouched.
 *
 * SAFETY: if the payload doesn't parse as the expected {entities,relations}
 * shape, we pass it through UNCHANGED — this can never break memory, only slim a
 * known-shaped search result. Disable entirely with PI_MEMORY_SEARCH_PREVIEW=0.
 *
 * Pure + dependency-free so it is unit-testable offline (see selftest.mjs).
 */

export interface PreviewConfig {
	/** Max chars of observation snippet kept per entity. 0 disables slimming. */
	perEntityCharBudget: number;
	/** Max entities previewed before collapsing the rest into a count. */
	maxEntities: number;
	/** How many leading observations to peek at per entity for the snippet. */
	obsPeek: number;
}

export function previewConfigFromEnv(env: Record<string, string | undefined> = process.env): PreviewConfig {
	const num = (name: string, def: number, min: number, max: number) => {
		const v = parseInt(env[name] || "", 10);
		return Number.isFinite(v) && v >= min && v <= max ? v : def;
	};
	// PI_MEMORY_SEARCH_PREVIEW: 0 = off (passthrough). Otherwise it's the per-entity
	// snippet char budget (default 240). Two extra knobs for entity count + peek.
	const raw = env.PI_MEMORY_SEARCH_PREVIEW;
	const perEntityCharBudget = raw === "0" ? 0 : num("PI_MEMORY_SEARCH_PREVIEW", 240, 40, 4000);
	return {
		perEntityCharBudget,
		maxEntities: num("PI_MEMORY_SEARCH_MAX_ENTITIES", 40, 1, 1000),
		obsPeek: num("PI_MEMORY_SEARCH_OBS_PEEK", 2, 1, 20),
	};
}

function isEntity(x: any): boolean {
	return x && typeof x === "object" && typeof x.name === "string" && Array.isArray(x.observations);
}

/** One compact line-set per entity: identity + size + a clamped snippet. */
function previewEntity(e: any, cfg: PreviewConfig): { name: string; entityType: string; observations: string } {
	const obs: string[] = e.observations.filter((o: any) => typeof o === "string");
	const peek = obs.slice(0, cfg.obsPeek).join(" ⏎ ");
	let snippet = peek.replace(/\s+/g, " ").trim();
	if (snippet.length > cfg.perEntityCharBudget) {
		snippet = snippet.slice(0, cfg.perEntityCharBudget).trimEnd() + "…";
	}
	const more = obs.length > cfg.obsPeek ? ` (+${obs.length - cfg.obsPeek} more obs)` : "";
	return {
		name: e.name,
		entityType: typeof e.entityType === "string" ? e.entityType : "",
		observations: `[${obs.length} obs] ${snippet}${more}`,
	};
}

/**
 * Slim a memory search_nodes result payload (the JSON text the server returns).
 * Returns the possibly-rewritten text. Pass-through on any unexpected shape.
 */
export function slimMemorySearchText(text: string, cfg: PreviewConfig): string {
	if (cfg.perEntityCharBudget <= 0) return text; // disabled
	if (!text || text.length < 200) return text; // already tiny / empty match -> leave it
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		return text; // not JSON -> never touch
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entities)) return text;
	const entities: any[] = parsed.entities;
	if (entities.length === 0 || !entities.every(isEntity)) return text;

	const shown = entities.slice(0, cfg.maxEntities).map((e) => previewEntity(e, cfg));
	const overflow = entities.length - shown.length;
	const relCount = Array.isArray(parsed.relations) ? parsed.relations.length : 0;

	const out: any = {
		_preview: true,
		_note:
			"search_nodes returns a PREVIEW (name + type + observation count + snippet). " +
			'Call open_nodes with the exact name(s) you need for full observations, e.g. open_nodes {"names":["<name>"]}.',
		matched: entities.length,
		entities: shown,
	};
	if (overflow > 0) out.entities_omitted = overflow;
	if (relCount > 0) out.relations_count = relCount; // names, not full dump
	return JSON.stringify(out, null, 2);
}

/** Should this (server, tool) result be slimmed? Only memory's fuzzy search. */
export function isMemorySearch(server: string, tool: string): boolean {
	return server.toLowerCase() === "memory" && tool.toLowerCase() === "search_nodes";
}
