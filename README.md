# xpow-hunt

> [!CAUTION]
> **Authorized security research only.** A public target, account, API key, or bug-bounty listing does not automatically authorize every test. Confirm written scope before each engagement, use the least invasive proof, and stop whenever authorization or impact is unclear. Read the full [Legal and Responsible-Use Disclaimer](DISCLAIMER.md) before installing or using this project.

`xpow-hunt` is a Pi-based security research coordinator for authorized bug-bounty work. It combines a primary coordinator, 23 focused subagents, a Kiro compatibility gateway, MCP integrations, deterministic scope checks, and a broad recon toolchain behind one command.

It supports three model routes:

- **Kiro** — the default; uses the bundled local Anthropic-compatible bridge and your current `kiro-cli` session.
- **Claude** — connects directly through Pi's native Anthropic provider.
- **Z.ai** — connects directly through Pi's native Z.ai provider.

No prompt, scope engine, model, or automated control can make a legal determination for you. You remain responsible for every command and tool call.

## How it works

```text
xpow-hunt
    │
    ├── coordinator prompts and scope policy
    ├── 23 specialist security agents
    ├── MCP bridge and per-agent MCP profiles
    ├── deterministic scope engine
    └── selected model route
         ├── Kiro → local kiro-gateway → Kiro API
         ├── Claude → Anthropic API
         └── Z.ai → Z.ai API
```

The coordinator maps the target, delegates bounded tasks to specialists, collects evidence on disk, challenges negative results, and recomposes low-severity signals into possible chains. A RAM-aware queue limits parallel subagents, while checkpoint recovery protects work when a model response is interrupted.

## Included components

### Coordinator and agents

- One main bug-bounty coordinator.
- 23 specialists covering recon, authorization, IDOR/BOLA, OAuth, injection, SQL injection, XSS, SSRF, RCE, path traversal, race conditions, request smuggling, cache poisoning, LLM security, triage, reporting, and more.
- Ensemble mode for multiple independent passes over one surface.
- Swarm mode for a bounded agent/task matrix.
- Reflexive disconfirmation for results blocked by WAFs, throttling, missing credentials, or ambiguous controls.
- Checkpoint recovery from files under `reports/<program>/`.

### Gateways and models

- `xpow-hunt` — main launcher and backend selector.
- `xpow-gateway` — starts and verifies the local Kiro bridge.
- `xpow-model` — saves the default backend.
- Bundled Kiro model catalog for Claude models exposed through Kiro.
- Native Pi routing for Anthropic Claude and Z.ai GLM models.

### MCP integrations

| Integration | Purpose | Extra setup |
|---|---|---|
| browser-live | Browser automation through Chrome DevTools | Chromium/Chrome |
| Burp | Burp Suite MCP bridge | Burp Suite + AI-Agent extension |
| memory | Persistent research memory | Installed through `npx` |
| GitHub | Repository and code research | GitHub token |
| Medium | Security write-up research | None |
| Gmail | Mail workflow integration | Google OAuth files |

Per-agent MCP profiles avoid launching heavyweight browser, Burp, or mail integrations for agents that do not need them.

### Security tooling

The optional extras installers cover a large external toolchain, including:

- Discovery: `subfinder`, `amass`, `chaos`, `dnsx`, `puredns`, `alterx`, `asnmap`.
- HTTP and crawling: `httpx`, `katana`, `gau`, `urlfinder`, `hakrawler`, `gospider`.
- Scanning and fuzzing: `nuclei`, `ffuf`, `feroxbuster`, `gobuster`, `arjun`, `x8`.
- Web testing: `dalfox`, `kxss`, `Gxss`, `crlfuzz`, `sqlmap`, `git-dumper`.
- Secrets and source review: `trufflehog`, `gitleaks`, `jsluice`, `getJS`, `mantra`.
- Network and TLS: `naabu`, `tlsx`, `cdncheck`, `mapcidr`, `interactsh-client`.
- Wordlists: SecLists.

These tools are not vendored into the repository; the agents call them from your normal `PATH`.

## Requirements

- macOS or a modern Linux distribution.
- Node.js 22 or newer and npm.
- Python 3.11 or newer.
- `curl`, `git`, and `rsync`.
- Kiro CLI for the default Kiro route.
- Java for the Burp MCP bridge.
- Chromium or Google Chrome for browser-live.

## Install

Clone the repository:

```bash
git clone https://github.com/yassiryt/xpow-hunt.git
cd xpow-hunt
```

Preview the installation without changing anything:

```bash
./install-macos.sh --dry-run   # macOS
./install.sh --dry-run         # Linux
```

Install the framework:

```bash
./install-macos.sh             # macOS
./install.sh                   # Linux
```

The installer:

1. Installs the pinned Pi runtime.
2. Backs up an existing `~/.pi/agent` configuration.
3. Installs agents, extensions, prompts, skills, and launchers.
4. Creates the Kiro gateway virtual environment.
5. Installs the included MCP server components.
6. Resolves all `__XPOW_HOME__` template paths to the current user's home directory.
7. Installs a launchd service on macOS or a user systemd service on Linux.
8. Runs offline self-tests.

The installer is designed to be rerunnable. Existing targets are copied to timestamped backups before replacement.

### Optional recon tools

```bash
./extras-macos.sh              # macOS
./extras.sh                    # Linux; some packages require sudo
```

Run the extras installer with `--dry-run` first if you want to review every package.

## Configure

### Kiro

Authenticate once:

```bash
kiro-cli login
```

Kiro is the default route. The gateway reads the current Kiro CLI session and starts locally on `127.0.0.1:8790` when needed.

```bash
xpow-model kiro
xpow-hunt
```

Change the gateway port if required:

```bash
export KIRO_GW_PORT=8791
```

### Claude

Set the Anthropic API key in your shell or secret manager, never in this repository:

```bash
export ANTHROPIC_API_KEY="your-key"
xpow-model claude
xpow-hunt
```

### Z.ai

```bash
export ZAI_API_KEY="your-key"
xpow-model zai
xpow-hunt
```

### Override models

```bash
export XPOW_KIRO_MODEL="kiro/claude-opus-4.8:xhigh"
export XPOW_CLAUDE_MODEL="anthropic/claude-opus-4-6:high"
export XPOW_ZAI_MODEL="zai/glm-5.2:high"
```

The model IDs above are defaults, not hard requirements. Use models available to your provider account.

### GitHub MCP

Pass a token only at installation time:

```bash
GITHUB_MCP_TOKEN="your-token" ./install-macos.sh
```

The template uses `${GITHUB_MCP_TOKEN}` and does not include a real token.

### Gmail MCP

Place your own OAuth files outside the repository:

```text
~/.gmail-mcp/gcp-oauth.keys.json
~/.gmail-mcp/credentials.json
```

Then run:

```bash
npx @gongrzhe/server-gmail-autoauth-mcp auth
```

### Burp MCP

Install Burp Suite, add its AI-Agent extension, and enable the MCP server on `127.0.0.1:9876`. The included JAR is the stdio-to-SSE bridge, not Burp Suite itself.

## Use

Interactive session with the saved backend:

```bash
xpow-hunt
```

Choose a backend for one run:

```bash
xpow-hunt --gateway kiro
xpow-hunt --gateway claude
xpow-hunt --gateway zai
```

Start with a scoped instruction:

```text
Hunt <program> for CRITICAL
```

One-shot/headless usage:

```bash
xpow-hunt -p "Review the authorized scope in scope.txt and build a recon plan"
```

Check or change the saved backend:

```bash
xpow-model status
xpow-model kiro
xpow-model claude
xpow-model zai
```

## Important environment controls

| Variable | Default | Purpose |
|---|---:|---|
| `XPOW_GATEWAY` | `kiro` | Backend for the current run |
| `XPOW_KIRO_MODEL` | Kiro Claude Opus | Kiro model override |
| `XPOW_CLAUDE_MODEL` | Anthropic Claude Opus | Direct Claude model override |
| `XPOW_ZAI_MODEL` | Z.ai GLM | Z.ai model override |
| `PI_SUBAGENT_MAX_CONCURRENCY` | `4` | Concurrent specialist limit |
| `PI_SUBAGENT_MAX_QUEUE` | `256` | Maximum queued tasks |
| `PI_SUBAGENT_RAM_FLOOR_MB` | `900` | Pause launches below free-RAM floor |
| `PI_SUBAGENT_MAX_DEPTH` | `3` | Subagent recursion limit |
| `PI_SUBAGENT_RETRIES` | `2` | Empty/interrupted response retries |
| `PI_SUBAGENT_DISCONFIRM` | `1` | Challenge terminal-negative results |
| `PI_SUBAGENT_MCP_PROFILES` | `1` | Use slim per-agent MCP sets |
| `PI_SUBAGENT_CHECKPOINT_RECOVERY` | `1` | Recover summaries from report files |

## Verify and troubleshoot

Run the lightweight launcher test:

```bash
./tests/launcher-selftest.sh
```

Run the subagent and scope tests after installation:

```bash
cd ~/.pi/agent/extensions/subagent
node --experimental-strip-types ./selftest.mjs

~/.pi/agent/bin/scope_selftest.sh
```

Check the Kiro gateway:

```bash
curl -fsS http://127.0.0.1:8790/health
```

Common problems:

- **`xpow-hunt: command not found`** — add `~/.local/bin` to `PATH` and open a new terminal.
- **Kiro gateway startup failed** — run `kiro-cli login`, then inspect `~/tools/kiro-gateway/gw.log`.
- **Claude key missing** — export `ANTHROPIC_API_KEY` or select another backend.
- **Z.ai key missing** — export `ZAI_API_KEY` or select another backend.
- **Browser tools unavailable** — install Chrome/Chromium and check the browser-live launcher.
- **Burp tools unavailable** — start Burp and confirm its MCP endpoint is listening on port 9876.

## Security and privacy

This repository intentionally excludes:

- Kiro, Claude, Z.ai, GitHub, and Gmail credentials.
- Gateway `.env` files.
- Accumulated research memory.
- Hunt reports and target evidence.
- Browser profiles and cookies.
- Logs, PIDs, virtual environments, and installed dependencies.

Configuration templates use `__XPOW_HOME__`, which the installer resolves locally. Do not commit generated credentials, `.env` files, `reports/`, or memory databases.

## Legal terms

The project is provided as-is, without warranty. Its authors and contributors do not authorize unlawful access or testing outside an approved scope and, to the maximum extent permitted by law, disclaim liability for use or misuse. Third-party tools and services have their own terms and licenses.

These short terms are only a summary. The complete conditions, limitations, user responsibilities, third-party notice, and no-safe-harbor warning are in [DISCLAIMER.md](DISCLAIMER.md). A disclaimer cannot replace written authorization from the owner of a target or advice from a qualified lawyer.

## Upstream and licensing

The runtime is built on [Pi](https://pi.dev). The bundled Kiro gateway retains its upstream license and attribution in `kiro-gateway/`. MCP packages and external security tools keep their own licenses. Review those licenses before redistribution.
