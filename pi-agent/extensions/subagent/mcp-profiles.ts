/**
 * Per-agent MCP server profiles (RAM control for high fan-out)
 * ------------------------------------------------------------
 * Every subagent inherits the parent env, and mcp-bridge otherwise spawns its
 * OWN copy of every stdio MCP server. The costly ones (measured on the target
 * box) are:
 *   - burp        ~280MB  (a JVM: `java -Xmx256m ... mcp-proxy-all.jar`)
 *   - gmail       ~80MB   (node)
 *   - browser-live ~65MB  (node client; talks to the ALREADY-running shared
 *                          Chrome — it does NOT launch a new Chrome, so it is
 *                          comparatively cheap)
 *   - memory      ~65MB   (node; mandatory checkpoints -> always on)
 *   - medium      ~30MB   (node)
 *   - github       ~0MB   (REMOTE url, no child process -> always free to keep)
 *
 * So the big win is dropping the burp JVM from agents that never mutate raw
 * HTTP, and dropping gmail/medium from the ~20 agents that never touch them.
 * That turns analysis/research agents from ~670MB into ~215-245MB, which is
 * what makes wide ensemble/swarm/hypothesis fan-out viable on a small box.
 *
 * `memory` and `github` are added to EVERY profile automatically (see
 * profileFor): memory because checkpoints are mandatory in the workflow, github
 * because it is remote and free.
 *
 * Browser-live is included generously (it is cheap and shares one Chrome) for
 * anything that might touch a page; excluded only from pure-analysis/scope/
 * research agents. The profile is fixed at spawn time (a child cannot add a
 * server mid-run), so when in doubt we INCLUDE rather than starve a hunter.
 */

// Servers added to every profile regardless of the per-agent list below.
export const ALWAYS_SERVERS = ["memory", "github"] as const;

// Per-agent EXTRA servers (on top of ALWAYS_SERVERS). Keys are agent names as
// they appear in the agents/*.md frontmatter `name:` field.
export const MCP_PROFILES: Record<string, string[]> = {
	// Mapper: renders JS (browser) + raw probes (burp).
	recon: ["browser-live", "burp"],

	// Scope loaders: hit the platform API/web via `bash` curl only. No browser/burp.
	// (bugcrowd reads scope through the researcher web app with the `_bugcrowd_session`
	// cookie in $BUGCROWD_SESSION — still plain curl, so the minimal profile applies.)
	"h1-scope-loader": [],
	"intigriti-scope-loader": [],
	"bugcrowd-scope-loader": [],

	// HTTP-mutation hunters: burp is the core tool; browser where flows are JS.
	"sqli-hunter": ["burp"],
	"injection-hunter": ["burp"],
	"ssrf-hunter": ["burp"],
	"path-traversal-hunter": ["burp"],
	"request-smuggling-hunter": ["burp"],
	"rce-hunter": ["burp", "browser-live"],
	"xss-hunter": ["browser-live", "burp"],
	"idor-logic-hunter": ["burp", "browser-live"],
	"race-condition-hunter": ["burp", "browser-live"],
	"cache-poison-hunter": ["burp", "browser-live"],
	"oauth-hunter": ["browser-live", "burp"],
	"llm-hunter": ["browser-live", "burp"],
	"bypass-innovator": ["burp"],

	// Validator: must rerun raw HTTP (burp) and browser steps to confirm claims.
	"strict-triager": ["burp", "browser-live"],

	// Account lifecycle: browser for the flows, gmail for inbox/OTP. No burp JVM.
	"test-account-manager": ["browser-live", "gmail"],

	// Pure analysis: no browser, no burp JVM -> cheapest agents (~215MB).
	"security-analyzer": [],
	// Research: github (always) + medium for current technique writeups.
	"payload-researcher": ["medium"],
	"deep-research": ["browser-live", "medium"],
	// Hypothesis red-team (new): analysis only; github+memory cover it.
	"hypothesis-redteam": [],

	// Visual checks: browser only.
	"visual-security": ["browser-live"],
};

// Profile used for an agent name not present in MCP_PROFILES. Generous but still
// drops gmail+medium (the two least-used heavy-ish servers). A brand-new HTTP
// hunter therefore works out of the box (browser+burp+memory+github) without a
// map edit, while still saving RAM vs. connect-all.
export const DEFAULT_EXTRA_SERVERS = ["browser-live", "burp"];

/**
 * Resolve the comma-joined PI_MCP_ONLY value for an agent. Returns undefined to
 * mean "do not constrain" (connect all) — used only when profiles are disabled.
 * Always includes ALWAYS_SERVERS and de-duplicates.
 */
export function profileFor(agentName: string): string {
	const extra = agentName in MCP_PROFILES ? MCP_PROFILES[agentName] : DEFAULT_EXTRA_SERVERS;
	const set = new Set<string>();
	for (const s of ALWAYS_SERVERS) set.add(s);
	for (const s of extra) set.add(s);
	return Array.from(set).join(",");
}
