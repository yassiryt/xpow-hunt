#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/config"
mkdir -p "$HOME/.config/opencode/prompts/claude-agents" "$HOME/.kiro/steering" "$HOME/.pi/agent" "$TMP/bin"
touch "$HOME/.config/opencode/prompts/claude-agents/build.md" "$HOME/.kiro/steering/bugbounty-autoflow.md" "$HOME/.pi/agent/pi-coordinator-adapter.md"
printf '#!/usr/bin/env bash\nprintf "pi:%%s\\n" "$*"\n' > "$TMP/bin/pi"
printf '#!/usr/bin/env bash\nprintf "kiro:%%s\\n" "$*"\n' > "$TMP/bin/xpow-gateway"
chmod +x "$TMP/bin/pi" "$TMP/bin/xpow-gateway"
export PATH="$TMP/bin:$PATH"

out="$($ROOT/bin/xpow-hunt --gateway kiro test)"; [[ "$out" == kiro:*kiro/claude-opus-4.8*test* ]]
out="$(ANTHROPIC_API_KEY=test "$ROOT/bin/xpow-hunt" --gateway claude test)"; [[ "$out" == pi:*anthropic/claude-opus-4-6*test* ]]
out="$(ZAI_API_KEY=test "$ROOT/bin/xpow-hunt" --gateway zai test)"; [[ "$out" == pi:*zai/glm-5.2*test* ]]
if "$ROOT/bin/xpow-hunt" --gateway invalid >/dev/null 2>&1; then exit 1; fi
"$ROOT/bin/xpow-model" zai >/dev/null
[[ "$("$ROOT/bin/xpow-model" status)" == 'xpow-hunt gateway: zai' ]]
echo "launcher self-test passed"
