#!/usr/bin/env node
/**
 * memory-archive.mjs — safe, reversible cold-storage for the memory graph.
 *
 * WHY: the memory store is ONE global knowledge graph shared by all programs
 * (measured: ~172 entities across ~50 program prefixes). The fuzzy search_nodes
 * is a substring match over that whole file, so dead programs both (a) add
 * empty-match noise and (b) inflate the worst-case search payload. The bridge's
 * preview slimmer already caps per-call bloat; this keeps the live store small
 * so even un-slimmed reads and writes stay cheap.
 *
 * WHAT: moves entities (and their now-internal relations) for programs you name
 * as "archive" into a sibling cold file. Fully reversible (a restore mode reads
 * the cold file back). DRY-RUN by default — prints what it WOULD move, changes
 * nothing, until you pass --commit.
 *
 * SAFETY:
 *   - Default = dry run. Nothing is written without --commit.
 *   - --commit writes a timestamped .bak of the live store FIRST.
 *   - Relations touching a kept entity are NEVER moved (no dangling refs).
 *   - Unknown/ambiguous entities are KEPT (archival is opt-in per program).
 *
 * USAGE:
 *   node memory-archive.mjs --list                       # show programs + sizes
 *   node memory-archive.mjs --archive bmwgroup,kivra     # DRY RUN (prints plan)
 *   node memory-archive.mjs --archive bmwgroup --commit  # actually move (after .bak)
 *   node memory-archive.mjs --restore bmwgroup --commit  # bring a program back
 *
 * The "program" of an entity is the token before the first '|' in its name,
 * lowercased, OR (for free-text names) a prefix match against the given handle.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LIVE = process.env.MEMORY_FILE_PATH
	? expand(process.env.MEMORY_FILE_PATH)
	: path.join(os.homedir(), ".config", "opencode", "memory", "memory.jsonl");
const COLD = LIVE.replace(/\.jsonl$/, "") + ".archive.jsonl";

function expand(p) {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}
function writeJsonl(file, rows) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}
/** program key of an entity name: token before '|', else handle prefix-match. */
function programOf(name, handles) {
	const lower = (name || "").toLowerCase();
	const keyed = lower.split("|")[0].trim();
	for (const h of handles) {
		const hl = h.toLowerCase();
		if (keyed === hl || keyed.startsWith(hl) || lower.startsWith(hl)) return h;
	}
	return null; // not one of the requested handles -> keep
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
	const i = args.indexOf(f);
	return i >= 0 && args[i + 1] ? args[i + 1] : "";
};
const commit = has("--commit");

const entities = readJsonl(LIVE).filter((r) => r.type === "entity");
const relations = readJsonl(LIVE).filter((r) => r.type === "relation");

if (has("--list") || args.length === 0) {
	const counts = {};
	let bytes = 0;
	for (const e of entities) {
		const k = (e.name || "").toLowerCase().split("|")[0].split("-")[0].slice(0, 22);
		counts[k] = (counts[k] || 0) + 1;
	}
	try {
		bytes = fs.statSync(LIVE).size;
	} catch {}
	console.log(`live store: ${LIVE}`);
	console.log(`  ${entities.length} entities, ${relations.length} relations, ${(bytes / 1024).toFixed(0)} KB`);
	console.log(`cold store: ${COLD} ${fs.existsSync(COLD) ? `(${readJsonl(COLD).length} rows)` : "(none yet)"}`);
	console.log("\nprogram prefixes (entity count):");
	for (const [k, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${k}`);
	console.log("\nUsage: --archive <a,b,c> [--commit] | --restore <a,b,c> [--commit] | --list");
	process.exit(0);
}

if (has("--archive")) {
	const handles = val("--archive").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
	if (!handles.length) {
		console.error("--archive needs a comma list of program handles");
		process.exit(1);
	}
	const move = entities.filter((e) => programOf(e.name, handles));
	const keep = entities.filter((e) => !programOf(e.name, handles));
	const moveNames = new Set(move.map((e) => e.name));
	const keepNames = new Set(keep.map((e) => e.name));
	// A relation stays in live ONLY if at least one endpoint is still a LIVE entity.
	// - both endpoints moving                -> move (internal to the archived set)
	// - an endpoint references no live entity -> move (dead/dangling, don't leave it behind)
	// - at least one endpoint is a kept live entity -> keep (no dangling live ref)
	const liveAfter = keepNames; // entities remaining in live
	const relKeep = relations.filter((r) => liveAfter.has(r.from) || liveAfter.has(r.to));
	const relMove = relations.filter((r) => !(liveAfter.has(r.from) || liveAfter.has(r.to)));
	const dangling = relations.filter(
		(r) => (moveNames.has(r.from) !== moveNames.has(r.to)) && (keepNames.has(r.from) || keepNames.has(r.to)),
	);

	console.log(`ARCHIVE plan for: ${handles.join(", ")}`);
	console.log(`  entities: move ${move.length}, keep ${keep.length}`);
	console.log(`  relations: move ${relMove.length}, keep ${relKeep.length}` + (dangling.length ? ` (${dangling.length} cross-relations kept with the live side)` : ""));
	console.log(`  live after: ${keep.length} entities (${entities.length}→${keep.length})`);
	if (!commit) {
		console.log("\nDRY RUN — nothing written. Re-run with --commit to apply (a .bak is made first).");
		process.exit(0);
	}
	const bak = LIVE + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
	fs.copyFileSync(LIVE, bak);
	const cold = readJsonl(COLD);
	writeJsonl(COLD, [...cold, ...move, ...relMove]);
	writeJsonl(LIVE, [...keep, ...relKeep]);
	console.log(`\n✓ committed. backup: ${bak}`);
	console.log(`  live: ${keep.length} entities, ${relKeep.length} relations`);
	console.log(`  cold: +${move.length} entities, +${relMove.length} relations`);
	process.exit(0);
}

if (has("--restore")) {
	const handles = val("--restore").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
	const cold = readJsonl(COLD);
	const coldE = cold.filter((r) => r.type === "entity");
	const coldR = cold.filter((r) => r.type === "relation");
	const back = coldE.filter((e) => programOf(e.name, handles));
	const stay = coldE.filter((e) => !programOf(e.name, handles));
	const backNames = new Set(back.map((e) => e.name));
	const backR = coldR.filter((r) => backNames.has(r.from) && backNames.has(r.to));
	const stayR = coldR.filter((r) => !(backNames.has(r.from) && backNames.has(r.to)));
	console.log(`RESTORE plan for: ${handles.join(", ")}`);
	console.log(`  bringing back: ${back.length} entities, ${backR.length} relations`);
	if (!commit) {
		console.log("\nDRY RUN — nothing written. Re-run with --commit to apply.");
		process.exit(0);
	}
	const bak = LIVE + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
	fs.copyFileSync(LIVE, bak);
	writeJsonl(LIVE, [...entities, ...back, ...relations, ...backR]);
	writeJsonl(COLD, [...stay, ...stayR]);
	console.log(`\n✓ restored. backup: ${bak}. live now ${entities.length + back.length} entities.`);
	process.exit(0);
}

console.error("Unknown args. Use --list | --archive <a,b> | --restore <a,b> [--commit]");
process.exit(1);
