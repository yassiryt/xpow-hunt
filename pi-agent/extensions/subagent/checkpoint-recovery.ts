/**
 * checkpoint-recovery.ts — "the ctx exists but the return was empty" safety net.
 *
 * WHY: a subagent's only delivered result is its final assistant text. If it gets
 * cut off mid-tool-call, rate-limited, or errors after it already checkpointed work
 * to reports/<program>/..., the runner used to surface "(no output)" — the work was
 * on disk but invisible to the coordinator. This module reads what the run WROTE to
 * disk and rebuilds a summary so that work is never lost.
 *
 * Pure fs/path only (no pi deps) so it is unit-testable offline (see selftest.mjs).
 * It NEVER throws — recovery must never crash the runner.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface RecoverOptions {
	cwds: string[]; // candidate base dirs to resolve reports/ under (cwd, defaultCwd, process.cwd())
	task: string; // task text — may embed reports/<program>/... path hints
	sinceMs: number; // run start; files modified at/after this (minus skew) are "this run"
	maxFiles?: number; // cap artifacts listed (default 40)
	maxExcerptChars?: number; // per-file excerpt cap (default 600)
	maxTotalChars?: number; // whole-summary cap (default 6000)
}

// Files that carry the most signal in a finding folder, surfaced first.
const SIGNAL_ORDER = ["title.txt", "severity.txt", "weakness.txt", "asset.txt", "impact.md", "description.md", "response.md"];
const TEXT_EXT = new Set([".md", ".txt", ".json", ".csv", ".tsv", ".log", ".http", ".yaml", ".yml", ".sh"]);
const SKIP_DIR = new Set(["node_modules", ".git", ".browser-live", "chrome-profile", "recox_raw", "bundles", "srcmaps"]);
const MAX_FILE_BYTES = 64 * 1024; // don't read big blobs for an excerpt
const MAX_WALK_ENTRIES = 4000; // hard bound on tree traversal

/** Pull `reports/<program>` roots that the task text references, so we scan the right place. */
export function extractReportRoots(task: string): string[] {
	const roots = new Set<string>();
	if (typeof task === "string") {
		const re = /reports\/[A-Za-z0-9._-]+/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(task)) !== null) roots.add(m[0]);
	}
	return [...roots];
}

interface Hit {
	abs: string;
	rel: string; // path relative to its base cwd (stable, e.g. reports/acme/…/title.txt)
	mtimeMs: number;
	size: number;
	base: string;
}

function safeStat(p: string): fs.Stats | null {
	try {
		return fs.statSync(p);
	} catch {
		return null;
	}
}

function walk(dir: string, base: string, sinceMs: number, out: Hit[], counter: { n: number }, depth: number): void {
	if (depth > 8 || counter.n > MAX_WALK_ENTRIES) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (counter.n++ > MAX_WALK_ENTRIES) return;
		if (e.name.startsWith(".") && e.name !== ".env.example") continue;
		const abs = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIR.has(e.name)) continue;
			walk(abs, base, sinceMs, out, counter, depth + 1);
		} else if (e.isFile()) {
			const st = safeStat(abs);
			if (!st) continue;
			if (st.mtimeMs < sinceMs) continue; // only artifacts from this run
			out.push({ abs, rel: path.relative(base, abs), mtimeMs: st.mtimeMs, size: st.size, base });
		}
	}
}

function excerpt(abs: string, size: number, cap: number): string {
	if (size > MAX_FILE_BYTES) return `(binary/large file, ${size} bytes — see on disk)`;
	let txt = "";
	try {
		txt = fs.readFileSync(abs, "utf8");
	} catch {
		return "(unreadable)";
	}
	txt = txt.trim();
	if (txt.length <= cap) return txt;
	return txt.slice(0, cap) + ` … [+${txt.length - cap} chars on disk]`;
}

function rank(h: Hit): number {
	const name = path.basename(h.rel).toLowerCase();
	const i = SIGNAL_ORDER.indexOf(name);
	if (i >= 0) return i; // 0..6 : signal files first, in a sensible reading order
	const ext = path.extname(name);
	if (ext === ".md" || ext === ".txt") return 20;
	return 40; // other artifacts last
}

/**
 * Build a synthesized summary from artifacts written during this run, or null if none.
 */
export function recoverFromCheckpoint(opts: RecoverOptions): string | null {
	try {
		const maxFiles = opts.maxFiles ?? 40;
		const maxExcerpt = opts.maxExcerptChars ?? 600;
		const maxTotal = opts.maxTotalChars ?? 6000;
		const skew = 5000; // tolerate clock/flush skew
		const since = opts.sinceMs - skew;

		// Resolve scan roots: task-referenced reports/<prog> under each cwd, else <cwd>/reports.
		const taskRoots = extractReportRoots(opts.task);
		const scan: { dir: string; base: string }[] = [];
		const seen = new Set<string>();
		for (const base of opts.cwds.filter(Boolean)) {
			const add = (dir: string) => {
				const real = path.resolve(dir);
				if (seen.has(real)) return;
				if (safeStat(real)?.isDirectory()) {
					seen.add(real);
					scan.push({ dir: real, base: path.resolve(base) });
				}
			};
			if (taskRoots.length) for (const r of taskRoots) add(path.join(base, r));
			else add(path.join(base, "reports"));
		}
		if (!scan.length) return null;

		const hits: Hit[] = [];
		const counter = { n: 0 };
		for (const s of scan) walk(s.dir, s.base, since, hits, counter, 0);
		if (!hits.length) return null;

		// De-dupe by abs path, sort signal-first then most-recent.
		const uniq = new Map<string, Hit>();
		for (const h of hits) if (!uniq.has(h.abs)) uniq.set(h.abs, h);
		const all = [...uniq.values()].sort((a, b) => rank(a) - rank(b) || b.mtimeMs - a.mtimeMs);
		const listed = all.slice(0, maxFiles);

		const lines: string[] = [];
		lines.push(
			"[recovered-from-checkpoint] The subagent returned NO final summary (cut off mid-work, rate-limited, or errored), " +
				"but it checkpointed the following to disk during this run. Recovering it so the work is not lost:",
		);
		lines.push("");
		lines.push(`Artifacts written/updated this run (${all.length}${all.length > listed.length ? `, showing ${listed.length}` : ""}):`);
		for (const h of listed) lines.push(`- ${h.rel}`);
		lines.push("");
		lines.push("Excerpts (highest-signal first):");

		let total = lines.join("\n").length;
		// Prefer excerpting the signal files (rank < 20); cap total budget.
		for (const h of listed) {
			if (rank(h) >= 40) continue; // skip non-text/other for excerpts
			if (total >= maxTotal) break;
			const body = excerpt(h.abs, h.size, maxExcerpt);
			const block = `\n### ${h.rel}\n${body}\n`;
			if (total + block.length > maxTotal) break;
			lines.push(block);
			total += block.length;
		}

		lines.push(
			"\n[status: needs-more-evidence — this was reconstructed from disk, NOT from the agent's own verdict. " +
				"Re-run the same agent to finish/confirm; the full artifacts are on disk at the paths above.]",
		);
		return lines.join("\n");
	} catch {
		return null; // recovery must never crash the runner
	}
}

export function checkpointRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.PI_SUBAGENT_CHECKPOINT_RECOVERY ?? "1") !== "0";
}
