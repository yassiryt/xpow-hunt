/**
 * Offline self-test for the force-multiplier features.
 * Runs ZERO model calls / spawns ZERO subagents -> free + instant.
 *
 *   node --experimental-strip-types subagent/selftest.mjs
 *
 * Verifies the pure logic (ensemble/swarm builders, MCP profiles, RAM reader,
 * depth cap, retry classification). For runtime tool-registration + the live
 * mechanics test, see the runbook printed at the end.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const chk = (label, cond) => {
	if (!cond) {
		fail++;
		console.log("  FAIL " + label);
	} else console.log("  ok   " + label);
};

// ---- 1. ensemble + swarm builders (pure module, no pi deps) ------------------
console.log("\n[1] ensemble / swarm builders");
const { buildEnsembleTasks, buildSwarmTasks, DEFAULT_ENSEMBLE_ANGLES } = await import(
	path.join(here, "ensemble.ts")
);
{
	const e = buildEnsembleTasks("oauth-hunter", "Test login on auth.example.com", 4, undefined, undefined);
	chk("ensemble: 4 passes", e.length === 4);
	chk("ensemble: same agent every pass", e.every((t) => t.agent === "oauth-hunter"));
	chk("ensemble: base task in every pass", e.every((t) => t.task.includes("auth.example.com")));
	chk("ensemble: distinct angles", new Set(e.map((t) => t.task.match(/PASS [A-H]/)?.[0])).size === 4);
	chk("ensemble: return-contract footer present", e.every((t) => t.task.includes("END with a plain-text")));
	const v = buildEnsembleTasks("rce-hunter", "x", 99, ["only one"], undefined);
	chk("ensemble: variants override count", v.length === 1 && v[0].task.includes("only one"));
	chk("ensemble: passes<1 clamps to 1", buildEnsembleTasks("a", "b", 0, undefined, undefined).length === 1);

	const s = buildSwarmTasks([{ agent: "sqli-hunter", task: "t1" }, { agent: "ssrf-hunter", task: "t2" }]);
	chk("swarm: 2 valid cells", s.tasks.length === 2 && s.errors.length === 0);
	const s2 = buildSwarmTasks([{ agent: "x", task: "" }, { agent: "", task: "t" }, { agent: "ok", task: "ok" }]);
	chk("swarm: skips bad cells, reports errors", s2.tasks.length === 1 && s2.errors.length === 2);
	chk("swarm: empty input errors", buildSwarmTasks([]).errors.length === 1);
	chk("swarm: trims whitespace", buildSwarmTasks([{ agent: " r ", task: " d " }]).tasks[0].agent === "r");
}

// ---- 2. MCP profiles (pure module) -------------------------------------------
console.log("\n[2] per-agent MCP profiles");
const { profileFor, MCP_PROFILES } = await import(path.join(here, "mcp-profiles.ts"));
{
	for (const a of Object.keys(MCP_PROFILES)) {
		const p = profileFor(a).split(",");
		if (!(p.includes("memory") && p.includes("github") && new Set(p).size === p.length)) {
			fail++;
			console.log(`  FAIL profile ${a} -> ${p.join(",")}`);
		}
	}
	console.log(`  ok   all ${Object.keys(MCP_PROFILES).length} profiles include memory+github, no dupes`);
	chk("profile: scope-loader is minimal", profileFor("h1-scope-loader") === "memory,github");
	chk("profile: bugcrowd-scope-loader is minimal", profileFor("bugcrowd-scope-loader") === "memory,github");
	chk("profile: security-analyzer cheapest", profileFor("security-analyzer") === "memory,github");
	chk("profile: sqli has burp not browser", (() => {
		const p = profileFor("sqli-hunter").split(",");
		return p.includes("burp") && !p.includes("browser-live");
	})());
	chk("profile: test-account-manager has gmail not burp", (() => {
		const p = profileFor("test-account-manager").split(",");
		return p.includes("gmail") && !p.includes("burp");
	})());
	chk("profile: unknown agent -> sane default", (() => {
		const p = profileFor("brand-new-agent").split(",");
		return p.includes("browser-live") && p.includes("burp") && !p.includes("gmail");
	})());
}

// ---- 3. RAM reader (matches the runner's gate) -------------------------------
console.log("\n[3] RAM gate reader");
{
	const availableMemMB = () => {
		try {
			const m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s*kB/m);
			if (m) return Math.floor(Number(m[1]) / 1024);
		} catch {}
		return Math.floor(os.freemem() / (1024 * 1024));
	};
	const mb = availableMemMB();
	chk("ram: positive finite reading", Number.isFinite(mb) && mb > 0);
	console.log(`       available now: ${mb} MB (default floor 900 MB -> would ${mb < 900 ? "WAIT" : "PROCEED"})`);
}

// ---- 4. depth cap + retry classification logic -------------------------------
console.log("\n[4] depth cap + retry classification");
{
	const maxDepth = (env) => {
		const v = parseInt(env || "", 10);
		return Number.isFinite(v) && v >= 1 && v <= 8 ? v : 3;
	};
	const refused = (myDepth, env) => myDepth + 1 > maxDepth(env);
	chk("depth: coord(0)->d1..d2->d3 allowed", !refused(0) && !refused(1) && !refused(2));
	chk("depth: d3->d4 refused (default cap 3)", refused(3));
	chk("depth: env override raises cap", !refused(3, "5") && refused(5, "5"));

	const getFinalOutput = (msgs) => {
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.role === "assistant") for (const p of m.content) if (p.type === "text") return p.text;
		}
		return "";
	};
	const isFailed = (r) => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
	const isEmpty = (r) => isFailed(r) || getFinalOutput(r.messages).trim().length === 0;
	const txt = (s) => ({ role: "assistant", content: [{ type: "text", text: s }] });
	const toolOnly = () => ({ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] });
	chk("retry: good result NOT empty", !isEmpty({ exitCode: 0, messages: [txt("found a bug")] }));
	chk("retry: errored => empty", isEmpty({ exitCode: 0, stopReason: "error", messages: [txt("x")] }));
	chk("retry: tool-only/no-text => empty", isEmpty({ exitCode: 0, messages: [toolOnly()] }));
	chk("retry: text-then-tool => kept (not empty)", !isEmpty({ exitCode: 0, messages: [txt("candidate"), toolOnly()] }));
}

// ---- 5. reflexive disconfirmation gate (Vector #1) ---------------------------
console.log("\n[5] disconfirmation gate (verdict classifier)");
const { classifyVerdict, shouldDisconfirm, buildDisconfirmTask } = await import(path.join(here, "disconfirm.ts"));
{
	// The yahoo regression case: a 429 'rate limit' verdict MUST be challenged.
	const yahoo =
		"Status: BLOCKED on query1/query2 edge 429 'Too Many Requests' for our egress IP. Backing off, resume after cooldown. No findings yet.";
	chk("verdict: yahoo 429 'blocked' is classified blocked", classifyVerdict(yahoo) === "blocked");
	chk("verdict: blocked => disconfirm fires", shouldDisconfirm(classifyVerdict(yahoo)));

	chk("verdict: 'no vulnerability found' => negative", classifyVerdict("No vulnerability found, endpoint looks secure.") === "negative");
	chk("verdict: negative => disconfirm fires", shouldDisconfirm("negative"));
	chk("verdict: WAF/403 => blocked", classifyVerdict("All requests return 403, a WAF is blocking us.") === "blocked");
	chk("verdict: 'needs creds' => blocked", classifyVerdict("Cannot proceed, need a valid account/token for this flow.") === "blocked");

	// Positives must NEVER be disconfirmed (would waste a pass + risk derailing a real find).
	chk("verdict: 'validated' => positive", classifyVerdict("status: validated — IDOR confirmed, see report.") === "positive");
	chk("verdict: 'candidate' => positive", classifyVerdict("status: candidate. Reproduced cross-account read.") === "positive");
	chk("verdict: positive => NO disconfirm", !shouldDisconfirm(classifyVerdict("Confirmed SSRF, exploited cloud metadata.")));
	chk("verdict: confirmed-bypass beats blocked-mention", classifyVerdict("The WAF was present but bypass confirmed via grap%68ql; vulnerability confirmed.") === "positive");

	// needs-more-evidence is the coordinator's job, not the gate's.
	chk("verdict: needs-more-evidence => inconclusive (no auto-fire)", !shouldDisconfirm(classifyVerdict("status: needs-more-evidence; one more probe required.")));
	chk("verdict: empty => unknown (no auto-fire)", classifyVerdict("") === "unknown" && !shouldDisconfirm("unknown"));

	// The built task must force a DIFFERENT control, not a repeat.
	const dt = buildDisconfirmTask("Test MAD GraphQL on query1", yahoo, "blocked");
	chk("disconfirm task: names alternative mechanisms", /alternative|different mechanism|>=2|2 ?different/i.test(dt));
	chk("disconfirm task: forbids identical re-run", /do not re-run the identical|MUST differ|not just repeat/i.test(dt));
	chk("disconfirm task: carries original objective", dt.includes("Test MAD GraphQL on query1"));
	chk("disconfirm task: suggests concrete controls (encoding/egress/identity)", /grap%68ql|encoding|egress|protonvpn|identity|Content-Type/i.test(dt));
}

// ---- 6. files load via type-strip --check ------------------------------------
console.log("\n[6] memory search preview slimmer (context-bloat control)");
const { slimMemorySearchText, previewConfigFromEnv, isMemorySearch } = await import(
	path.join(here, "..", "mcp-bridge", "memory-preview.ts")
);
{
	const cfg = previewConfigFromEnv({});
	chk("preview: default budget is 240", cfg.perEntityCharBudget === 240);
	chk("preview: only memory:search_nodes is targeted", isMemorySearch("memory", "search_nodes") && !isMemorySearch("memory", "open_nodes") && !isMemorySearch("burp", "search_nodes"));

	// Build a fat, realistic payload: 30 entities each with 8 long observations.
	const fatObs = (i) => Array.from({ length: 8 }, (_, k) => `observation ${k} for entity ${i}: ` + "x".repeat(300));
	const fat = JSON.stringify({
		entities: Array.from({ length: 30 }, (_, i) => ({ name: `prog|asset${i}|idor`, entityType: "bug-hunt-finding", observations: fatObs(i) })),
		relations: [{ from: "a", to: "b", relationType: "x" }],
	});
	const slim = slimMemorySearchText(fat, cfg);
	chk("preview: slims the fat payload", slim.length < fat.length / 3);
	chk("preview: keeps every entity name (the index survives)", (() => {
		const o = JSON.parse(slim);
		return o._preview === true && o.matched === 30 && o.entities.length === 30 && o.entities.every((e) => e.name.startsWith("prog|asset"));
	})());
	chk("preview: tells the model to open_nodes for detail", /open_nodes/.test(slim));
	chk("preview: per-entity obs snippet is budget-bounded", JSON.parse(slim).entities.every((e) => e.observations.length < 240 + 80));
	chk("preview: surfaces obs COUNT so model knows there's more", /\[8 obs\]/.test(slim));

	// Safety: never break on unexpected shapes -> passthrough unchanged.
	chk("preview: non-JSON passes through unchanged", slimMemorySearchText("Entities deleted successfully", cfg) === "Entities deleted successfully");
	chk("preview: tiny/empty match passes through", slimMemorySearchText('{"entities":[],"relations":[]}', cfg) === '{"entities":[],"relations":[]}');
	chk("preview: wrong-shape JSON passes through", slimMemorySearchText('{"foo":1,"bar":[1,2,3]}'.padEnd(250, " "), cfg).includes('"foo":1'));
	chk("preview: budget 0 disables (full passthrough)", (() => {
		const off = previewConfigFromEnv({ PI_MEMORY_SEARCH_PREVIEW: "0" });
		return off.perEntityCharBudget === 0 && slimMemorySearchText(fat, off) === fat;
	})());
	const tok = (s) => Math.round(s.length / 4);
	console.log(`       fat payload ${tok(fat)} tok -> preview ${tok(slim)} tok (${100 - Math.round((100 * slim.length) / fat.length)}% smaller); open_nodes returns full detail`);
}

// ---- 7. checkpoint recovery ("ctx exists but empty return" safety net) -------
console.log("\n[7] checkpoint recovery (surfaces on-disk work when the return is empty)");
const { recoverFromCheckpoint, extractReportRoots, checkpointRecoveryEnabled } = await import(
	path.join(here, "checkpoint-recovery.ts")
);
{
	chk("extract: pulls reports/<prog> from task text", extractReportRoots("checkpoint to reports/acme/20260701-x/ as you go").includes("reports/acme"));
	chk("enabled: default on", checkpointRecoveryEnabled({}) === true);
	chk("enabled: PI_SUBAGENT_CHECKPOINT_RECOVERY=0 disables", checkpointRecoveryEnabled({ PI_SUBAGENT_CHECKPOINT_RECOVERY: "0" }) === false);

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
	const fdir = path.join(tmp, "reports", "acme", "20260701-1200-idor");
	fs.mkdirSync(fdir, { recursive: true });
	fs.writeFileSync(path.join(fdir, "title.txt"), "IDOR on /api/orders lets user A read user B orders");
	fs.writeFileSync(path.join(fdir, "description.md"), "Repro:\n1. login A\n2. curl /api/orders?id=<B> -> 200 with B's data\n");
	fs.writeFileSync(path.join(fdir, "severity.txt"), "High");

	const rec = recoverFromCheckpoint({ cwds: [tmp], task: "hunt acme; write to reports/acme/...", sinceMs: Date.now() - 60000 });
	chk("recovery: returns text when recent artifacts exist", typeof rec === "string" && rec.length > 0);
	chk("recovery: surfaces the finding title", !!rec && rec.includes("IDOR on /api/orders"));
	chk("recovery: lists artifact path", !!rec && rec.includes("reports/acme/20260701-1200-idor/title.txt"));
	chk("recovery: excerpts the description repro", !!rec && rec.includes("curl /api/orders?id="));
	chk("recovery: labelled recovered-from-checkpoint", !!rec && /recovered-from-checkpoint/i.test(rec));
	chk("recovery: flags needs-more-evidence (not a self-verdict)", !!rec && /needs-more-evidence/i.test(rec));

	const none = recoverFromCheckpoint({ cwds: [tmp], task: "x", sinceMs: Date.now() + 60000 });
	chk("recovery: nothing written this run => null (honest empty)", none === null);
	const noDir = recoverFromCheckpoint({ cwds: [path.join(tmp, "does-not-exist")], task: "x", sinceMs: 0 });
	chk("recovery: missing reports dir => null, never throws", noDir === null);
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 8. files load via type-strip --check ------------------------------------
console.log("\n[8] static load check (run separately):");
console.log("    for f in mcp-bridge/index.ts mcp-bridge/memory-preview.ts subagent/index.ts subagent/ensemble.ts subagent/mcp-profiles.ts subagent/disconfirm.ts subagent/checkpoint-recovery.ts; do");
console.log('      node --experimental-strip-types --check "$f"; done');

console.log("\n" + (fail === 0 ? "✅ OFFLINE SELF-TEST: ALL PASS" : `❌ ${fail} CHECK(S) FAILED`));
process.exit(fail === 0 ? 0 : 1);
