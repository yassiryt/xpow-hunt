/**
 * MCP Bridge for pi
 * -----------------
 * pi ships no built-in MCP. This extension connects to the SAME MCP servers
 * kiro-cli uses (reads kiro's mcp.json by default) and exposes each MCP tool
 * to pi as a native tool named `<server>_<tool>`.
 *
 * Config source (first that exists):
 *   1. $PI_MCP_CONFIG
 *   2. ~/.pi/agent/mcp.json
 *   3. ~/.kiro/settings/mcp.json   (mirror kiro-cli exactly)
 *
 * Per-server fields (kiro/Claude-style): command,args,env[,cwd]  OR  url,headers ;
 * plus optional `disabled` and `timeout` (ms).
 *
 * Clean exit: stdio MCP servers are spawned as child processes. close() alone
 * leaves script-launched children lingering, which keeps pi alive in print/json
 * mode (and would hang subagents). We capture the child and SIGKILL it on
 * session_shutdown, and unref it at connect time as a second safeguard.
 *
 * Set PI_MCP_BRIDGE_DISABLE=1 to skip entirely.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMemorySearch, previewConfigFromEnv, slimMemorySearchText } from "./memory-preview.ts";

// Built once at load: how aggressively to slim memory search_nodes previews.
const MEMORY_PREVIEW_CFG = previewConfigFromEnv();

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function resolveConfigPath(): string | undefined {
  const candidates = [
    process.env.PI_MCP_CONFIG,
    path.join(os.homedir(), ".pi", "agent", "mcp.json"),
    path.join(os.homedir(), ".kiro", "settings", "mcp.json"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(expandHome(c))) return expandHome(c);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function schemaForPi(inputSchema: any): any {
  if (inputSchema && typeof inputSchema === "object" && inputSchema.type) return inputSchema;
  return { type: "object", properties: {}, additionalProperties: true };
}

// --- Hardening: tool denylist + cross-process lock for stateful servers --------
// Hide specific MCP tools entirely (the model never sees them). Default drops the
// memory server's `read_graph` (returns the WHOLE graph -> expensive & unneeded;
// use search_nodes/open_nodes instead). Override/extend via KIRO_MCP_DENY_TOOLS
// (comma list of `server:tool`, or `*:tool`).
const DENY_TOOLS: Set<string> = new Set(
  (process.env.KIRO_MCP_DENY_TOOLS || "memory:read_graph")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
function isDenied(server: string, tool: string): boolean {
  const k = `${server}:${tool}`.toLowerCase();
  return DENY_TOOLS.has(k) || DENY_TOOLS.has(`*:${tool}`.toLowerCase());
}

// --- Per-process server profile (RAM control for high fan-out) -----------------
// Each subagent inherits the parent env and, by default, spawns its OWN copy of
// EVERY stdio MCP server (burp = a JVM, memory/medium/gmail/browser = node each).
// On a small box that is ~700MB-1GB per subagent and is what caps real fan-out.
// PI_MCP_ONLY="a,b"  -> connect ONLY these servers (allowlist, by mcp.json name).
// PI_MCP_EXCLUDE="x" -> connect everything EXCEPT these (denylist).
// `github` is remote (no child process) so it is effectively free to keep.
// Allowlist wins over denylist when both are set. Empty/unset = current behavior
// (connect all), so this is fully backward compatible.
const MCP_ONLY: Set<string> = new Set(
  (process.env.PI_MCP_ONLY || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const MCP_EXCLUDE: Set<string> = new Set(
  (process.env.PI_MCP_EXCLUDE || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
function serverAllowed(name: string): boolean {
  const n = name.toLowerCase();
  if (MCP_ONLY.size > 0) return MCP_ONLY.has(n);
  if (MCP_EXCLUDE.size > 0) return !MCP_EXCLUDE.has(n);
  return true;
}

// Servers whose tool calls must be serialized across ALL pi processes. The memory
// knowledge-graph is read-modify-write on a single file, so many concurrent
// subagents would lose updates / corrupt it without a cross-process lock.
const LOCK_SERVERS: Set<string> = new Set(
  (process.env.KIRO_MCP_LOCK_SERVERS || "memory")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Cross-process mutex via atomic mkdir (atomic on POSIX). A crashed holder's lock
// is reclaimed after staleMs; if not acquired within timeoutMs we proceed
// unlocked rather than deadlock the agent.
async function withFileLock<T>(lockDir: string, fn: () => Promise<T>, timeoutMs = 20000, staleMs = 30000): Promise<T> {
  const start = Date.now();
  let held = false;
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  } catch {
    /* ignore */
  }
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
      break;
    } catch (e: any) {
      if (e && e.code === "EEXIST") {
        try {
          const st = fs.statSync(lockDir);
          if (Date.now() - st.mtimeMs > staleMs) {
            try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
            continue;
          }
        } catch {
          /* lock vanished -> retry */
        }
        if (Date.now() - start > timeoutMs) break; // give up waiting; proceed unlocked
        await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 40)));
      } else {
        break; // unexpected fs error -> proceed unlocked
      }
    }
  }
  try {
    return await fn();
  } finally {
    if (held) {
      try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
    }
  }
}

// Collect a pid + all its descendants from /proc (Linux). Used to reap stdio MCP
// servers launched via wrappers (npx, launch.sh) whose grandchildren would
// otherwise keep pi's event loop alive (print/json/subagent modes).
function collectTree(rootPid: number): number[] {
  const ppidOf = new Map<number, number>();
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const rparen = stat.lastIndexOf(")");
        const rest = stat.slice(rparen + 2).split(" "); // [state, ppid, ...]
        ppidOf.set(pid, Number(rest[1]));
      } catch {
        /* process vanished */
      }
    }
  } catch {
    return [rootPid];
  }
  const out: number[] = [];
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!;
    for (const [pid, par] of ppidOf) {
      if (par === p && !out.includes(pid)) {
        out.push(pid);
        stack.push(pid);
      }
    }
  }
  return out;
}

async function killTree(rootPid?: number): Promise<void> {
  if (!rootPid) return;
  const seen = new Set<number>();
  // Two snapshots ~120ms apart: wrapper launchers (npx, launch.sh) spawn the
  // real server slightly after connect; capture those while the parent link
  // still exists, then SIGKILL everything (root last).
  for (let i = 0; i < 2; i++) {
    try {
      for (const pid of collectTree(rootPid)) seen.add(pid);
    } catch {
      /* ignore */
    }
    if (i === 0) await new Promise((r) => setTimeout(r, 120));
  }
  seen.add(rootPid);
  for (const pid of seen) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

interface Conn {
  name: string;
  client: any;
  transport: any;
  child: any;
}

export default function mcpBridge(pi: ExtensionAPI) {
  let started = false;
  const conns: Conn[] = [];
  const status: string[] = [];

  async function connectAll() {
    if (started) return;
    started = true;

    if (process.env.PI_MCP_BRIDGE_DISABLE === "1") {
      console.error("[mcp-bridge] disabled via PI_MCP_BRIDGE_DISABLE=1");
      return;
    }

    const cfgPath = resolveConfigPath();
    if (!cfgPath) {
      console.error("[mcp-bridge] no mcp.json found");
      return;
    }

    let cfg: any;
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (e) {
      console.error(`[mcp-bridge] failed to parse ${cfgPath}: ${String(e)}`);
      return;
    }
    const servers = cfg.mcpServers || cfg.servers || {};

    // Apply the per-process server profile (PI_MCP_ONLY / PI_MCP_EXCLUDE) up front
    // so a slimmed child never even imports the SDK transports for servers it skips.
    const skipped: string[] = [];

    let sdk: any, stdioMod: any, httpMod: any, sseMod: any;
    try {
      sdk = await import("@modelcontextprotocol/sdk/client/index.js");
      stdioMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
      httpMod = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      sseMod = await import("@modelcontextprotocol/sdk/client/sse.js");
    } catch (e) {
      console.error(`[mcp-bridge] MCP SDK not installed (npm install in this dir): ${String(e)}`);
      return;
    }

    for (const [name, sc] of Object.entries<any>(servers)) {
      if (!sc || sc.disabled === true) continue;
      if (!serverAllowed(name)) {
        skipped.push(name);
        continue;
      }
      const tag = sanitize(name);
      const timeout = typeof sc.timeout === "number" ? sc.timeout : 30000;
      // Cap connect/list so a slow/unavailable server (e.g. browser-live's 180s
      // tool timeout) cannot stall pi startup. Tool calls still use the full timeout.
      const connectTimeout = Math.min(timeout, 30000);
      try {
        const client = new sdk.Client({ name: "pi-mcp-bridge", version: "1.0.0" }, { capabilities: {} });
        let transport: any;
        let child: any = null;

        if (sc.url) {
          const url = new URL(sc.url);
          const headers = sc.headers || {};
          try {
            transport = new httpMod.StreamableHTTPClientTransport(url, { requestInit: { headers } });
            await withTimeout(client.connect(transport), connectTimeout, `${name} connect(http)`);
          } catch {
            transport = new sseMod.SSEClientTransport(url, { requestInit: { headers } });
            await withTimeout(client.connect(transport), connectTimeout, `${name} connect(sse)`);
          }
        } else if (sc.command) {
          transport = new stdioMod.StdioClientTransport({
            command: sc.command,
            args: sc.args || [],
            env: { ...process.env, ...(sc.env || {}) },
            cwd: sc.cwd,
            stderr: "ignore",
          });
          await withTimeout(client.connect(transport), connectTimeout, `${name} connect(stdio)`);
          // Server stderr -> /dev/null: keeps the pi TUI clean (no Burp/OAuth banner
          // spam) AND avoids a lingering stderr pipe that would keep pi's event loop
          // alive in -p/json mode (which would hang every subagent on exit).
          // Capture the spawned child now (close() clears it later) and unref so it
          // does not keep pi's event loop alive in print/json/subagent modes.
          child = (transport as any)._process;
          try {
            child?.unref?.();
            child?.stdin?.unref?.();
            child?.stdout?.unref?.();
            child?.stderr?.unref?.();
          } catch {
            /* ignore */
          }
        } else {
          continue;
        }

        const listed = await withTimeout(client.listTools(), connectTimeout, `${name} listTools`);
        const tools = listed?.tools || [];
        const useLock = LOCK_SERVERS.has(name.toLowerCase());
        const lockDir =
          sc.env && sc.env.MEMORY_FILE_PATH
            ? expandHome(String(sc.env.MEMORY_FILE_PATH)) + ".pi-lock"
            : path.join(os.tmpdir(), `pi-mcp-${tag}.pi-lock`);
        let registered = 0;
        for (const t of tools) {
          if (isDenied(name, t.name)) continue; // hardening: e.g. memory:read_graph
          const toolName = `${tag}_${sanitize(t.name)}`.slice(0, 64);
          try {
            pi.registerTool({
              name: toolName,
              label: `${name}:${t.name}`,
              description: (t.description || `${name} ${t.name}`).slice(0, 1024),
              parameters: schemaForPi(t.inputSchema),
              async execute(_toolCallId: string, params: any) {
                const call = () =>
                  withTimeout(
                    client.callTool({ name: t.name, arguments: params || {} }),
                    Math.max(timeout, 120000),
                    `${name}.${t.name}`,
                  );
                try {
                  // Serialize stateful servers (memory) across ALL pi processes so
                  // concurrent read-modify-write cycles can't lose updates/corrupt.
                  const res: any = useLock ? await withFileLock(lockDir, call) : await call();
                  const content = (res?.content || []).map((c: any) =>
                    c?.type === "text" ? { type: "text", text: c.text } : { type: "text", text: JSON.stringify(c) },
                  );
                  // Context-bloat control: turn memory's fuzzy search_nodes (which
                  // returns FULL entities across all programs -> measured 19k-24k
                  // token dumps) into a compact preview. open_nodes stays full.
                  // Passthrough on any unexpected shape, so it can't break memory.
                  if (!res?.isError && isMemorySearch(name, t.name)) {
                    for (const part of content) {
                      if (part?.type === "text" && typeof part.text === "string") {
                        part.text = slimMemorySearchText(part.text, MEMORY_PREVIEW_CFG);
                      }
                    }
                  }
                  return {
                    content: content.length ? content : [{ type: "text", text: res?.isError ? "(error)" : "(no content)" }],
                    details: { server: name, tool: t.name, isError: !!res?.isError },
                  };
                } catch (e) {
                  return {
                    content: [{ type: "text", text: `MCP call failed (${name}.${t.name}): ${String(e)}` }],
                    details: { server: name, tool: t.name, error: true },
                  };
                }
              },
            });
            registered++;
          } catch (e) {
            console.error(`[mcp-bridge] registerTool ${toolName} failed: ${String(e)}`);
          }
        }
        conns.push({ name, client, transport, child });
        const hidden = tools.length - registered;
        status.push(`${name}: ${registered} tools${hidden ? ` (+${hidden} hidden)` : ""}${useLock ? " [locked]" : ""}`);
        console.error(
          `[mcp-bridge] connected ${name}: ${registered} tools` +
            (hidden ? ` (${hidden} hidden by denylist)` : "") +
            (useLock ? " [cross-process locked]" : ""),
        );
      } catch (e) {
        status.push(`${name}: FAILED ${String(e).slice(0, 100)}`);
        console.error(`[mcp-bridge] ${name} failed: ${String(e).slice(0, 200)}`);
      }
    }

    if (skipped.length) {
      const why = MCP_ONLY.size > 0 ? `PI_MCP_ONLY=${[...MCP_ONLY].join(",")}` : `PI_MCP_EXCLUDE=${[...MCP_EXCLUDE].join(",")}`;
      status.push(`skipped (${why}): ${skipped.join(", ")}`);
      console.error(`[mcp-bridge] skipped ${skipped.length} server(s) via ${why}: ${skipped.join(", ")}`);
    }
  }

  async function closeOne(c: Conn) {
    const child = c.child || (c.transport as any)?._process;
    // Kill the whole tree FIRST, while the wrapper is still the parent of its
    // grandchildren (after close() the grandchildren get reparented to init and
    // can no longer be found via PPID).
    try {
      if (child?.pid) await killTree(child.pid);
    } catch {
      /* ignore */
    }
    try {
      await c.client?.close?.();
    } catch {
      try {
        await c.transport?.close?.();
      } catch {
        /* ignore */
      }
    }
  }

  pi.on("session_start", async () => {
    await connectAll();
  });

  pi.on("session_shutdown", async () => {
    console.error(`[mcp-bridge] shutdown: closing ${conns.length} server(s)`);
    await Promise.allSettled(conns.map(closeOne));
    // pi 0.79 can hang the process on exit in non-interactive (-p / --mode json|rpc)
    // mode once any stdio MCP server was spawned (even after the child is reaped).
    // That mode is exactly how subagents run, and a hung child = lost findings.
    // In headless mode only, force a clean exit AFTER output buffers drain (so a
    // subagent's final JSON is never truncated). Interactive TUI is untouched.
    const a = process.argv;
    const headless =
      a.includes("-p") || a.includes("--print") || (a.includes("--mode") && (a.includes("json") || a.includes("rpc")));
    if (headless) {
      const flushAndExit = () => {
        try {
          if (process.stdout.writableLength > 0 || process.stderr.writableLength > 0) {
            setTimeout(flushAndExit, 25).unref?.();
            return;
          }
        } catch {
          /* ignore */
        }
        try {
          process.exit(0);
        } catch {
          /* ignore */
        }
      };
      setTimeout(flushAndExit, 25).unref?.();
    }
  });

  pi.registerCommand("mcp", {
    description: "Show MCP bridge status (connected servers and tool counts)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("MCP bridge: " + (status.length ? status.join("  |  ") : "no servers connected"), "info");
    },
  });
}
