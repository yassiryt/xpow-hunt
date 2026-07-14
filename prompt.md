
You are restoring **xpow-hunt** onto this machine from the bundle in the current
working directory. xpow-hunt is a [pi.dev](https://pi.dev) coding agent acting as
an autonomous bug-bounty **coordinator** on Kiro's Claude Opus 4.8, backed by a
local **kiro-gateway** bridge, with 23 specialist subagents and 6 MCP servers
(browser-live, burp, memory, github, medium, gmail).

Work through this in order. Use the shell. Be careful and verify each step.

## 1. Orient
- Read `README.md` and `VERSIONS.txt` in this directory. They describe the exact
  layout and the required toolchain (Node 22+, npm, python3 3.11+, java for the
  burp MCP, chromium for browser-live).

## 2. Prerequisites
- Confirm `node` (v22+), `npm`, `python3`, `curl`, `rsync`, `git` are present.
  Install any that are missing before continuing.
- Note (don't fail) if `java` or `chromium` are missing — burp and browser-live
  need them; the installer warns too.

## 3. Restore the framework
```bash
./install.sh --dry-run     # review the plan, change nothing
./install.sh               # apply
```
- If you already have the GitHub MCP token, run instead:
  `GITHUB_MCP_TOKEN=ghp_xxxxx ./install.sh` (otherwise it prompts, or you edit
  `~/.kiro/settings/mcp.json` later — replace the `${GITHUB_MCP_TOKEN}` placeholder).
- The installer is idempotent and backs up anything it overwrites. It re-homes
  all `__XPOW_HOME__` paths to this machine's `$HOME`, builds the gateway Python
  venv, npm-installs pi 0.79.0 + the MCP server deps, places every config/agent/
  MCP server, and enables the systemd gateway service with linger.

## 4. Install the runtime hunting toolchain
```bash
./extras.sh                # recon CLIs (httpx, katana, dnsx, nuclei, ffuf, …) + SecLists
```
- This is what lets the specialist agents actually run recon and fuzzing.
- If it warns about PATH, add `~/go/bin` to PATH (e.g. `export PATH="$HOME/go/bin:$PATH"`).

## 5. Re-establish the 4 machine-specific credentials (NOT in the bundle — they are secrets)
1. **kiro-cli** — the gateway follows kiro-cli's live token. Verify kiro-cli is
   installed, then run `kiro-cli login`. Without this, every model call 401s.
2. **GitHub MCP token** — if not set in step 3, ask the user for a `ghp_…` token
   and put it in `~/.kiro/settings/mcp.json` (replace `${GITHUB_MCP_TOKEN}`).
3. **Gmail MCP** — place the user's `gcp-oauth.keys.json` and `credentials.json`
   in `~/.gmail-mcp/`, then run `npx @gongrzhe/server-gmail-autoauth-mcp auth`.
4. **Burp** — install Burp Suite + its AI-Agent extension and enable the MCP
   server on `127.0.0.1:9876` (the bundled jar bridges to it).

## 6. Verify
- `systemctl --user status kiro-gateway` → active; `curl -s 127.0.0.1:8790/health` → 200.
- `pi --version` → `0.79.0`.
- Launch `xpow-hunt`. It should start the coordinator on `claude-opus-4.8` and the
  model should have the MCP tools available (browser-live / burp / memory /
  github / medium / gmail). If a tool is missing, check the corresponding entry
  and paths in `~/.kiro/settings/mcp.json` and that its server deps installed
  (e.g. `~/.claude/mcp` and `~/.local/share/browser-live/chrome-devtools-mcp`
  each have `node_modules`).

## Rules
- Never invent paths, tokens, or credentials. If something secret is missing,
  STOP and ask the user for it.
- If `install.sh` or `extras.sh` fails, read the error, fix the root cause
  (missing dependency, PATH, permissions), and re-run — both are safe to re-run.
- Do not push anything to any bug-bounty platform; this setup stops at local use.
- Finish with a short summary: what was installed, the gateway health result,
  and which of the 4 credentials still need the user's action.
