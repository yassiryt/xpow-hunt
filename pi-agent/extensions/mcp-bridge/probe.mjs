import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import * as fs from "node:fs";
import * as os from "node:os";

function collectTree(root) {
  const ppid = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const pid = +d;
    try { const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); const r = s.lastIndexOf(")"); ppid.set(pid, +s.slice(r + 2).split(" ")[1]); } catch {}
  }
  const out = []; const st = [root];
  while (st.length) { const p = st.pop(); for (const [pid, par] of ppid) if (par === p && !out.includes(pid)) { out.push(pid); st.push(pid); } }
  return out;
}
async function killTree(root) {
  if (!root) return; const seen = new Set();
  for (let i = 0; i < 2; i++) { for (const pid of collectTree(root)) seen.add(pid); if (i === 0) await new Promise((r) => setTimeout(r, 120)); }
  seen.add(root);
  for (const pid of seen) { try { process.kill(pid, "SIGKILL"); } catch {} }
}
function withTimeout(p, ms, l) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(l + " timeout " + ms + "ms")), ms))]); }

const cfg = JSON.parse(fs.readFileSync(os.homedir() + "/.kiro/settings/mcp.json", "utf8"));
const servers = cfg.mcpServers || {};
const SKIP = new Set(["browser-live"]); // heavy (launches/【shares Chrome); validated separately
const TIMEOUT = 15000;

for (const [name, sc] of Object.entries(servers)) {
  if (sc?.disabled) { console.log(`${name}: (disabled in kiro config, skipped)`); continue; }
  if (SKIP.has(name)) { console.log(`${name}: (skipped here to avoid disturbing shared Chrome)`); continue; }
  const client = new Client({ name: "probe", version: "1" }, { capabilities: {} });
  let transport, child = null;
  try {
    if (sc.url) {
      transport = new StreamableHTTPClientTransport(new URL(sc.url), { requestInit: { headers: sc.headers || {} } });
      await withTimeout(client.connect(transport), TIMEOUT, name);
    } else {
      transport = new StdioClientTransport({ command: sc.command, args: sc.args || [], env: { ...process.env, ...(sc.env || {}) } });
      await withTimeout(client.connect(transport), TIMEOUT, name);
      child = transport._process;
    }
    const tools = (await withTimeout(client.listTools(), TIMEOUT, name)).tools || [];
    console.log(`${name}: OK ${tools.length} tools  e.g. [${tools.slice(0, 6).map((t) => t.name).join(", ")}${tools.length > 6 ? ", ..." : ""}]`);
  } catch (e) {
    console.log(`${name}: FAIL ${String(e?.message || e).slice(0, 120)}`);
  } finally {
    try { if (child?.pid) await killTree(child.pid); } catch {}
    try { await client.close(); } catch {}
  }
}
process.exit(0);
