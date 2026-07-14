#!/usr/bin/env bash
# scope_selftest.sh — offline, self-contained regression test for the scope engine.
# No model calls, no network. Run by install scripts and anytime:
#   ~/.pi/agent/bin/scope_selftest.sh
# Exits 0 on all-pass, 1 on any failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/scope_build.sh"; CHECK="$HERE/scope_check.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# --- fixture: HackerOne GraphQL structured_scopes shape (mixed in/out) ---------
cat > "$TMP/raw.json" <<'JSON'
{"data":{"team":{"structured_scopes":{"edges":[
 {"node":{"asset_type":"WILDCARD","asset_identifier":"*.example.com","eligible_for_bounty":true,"max_severity":"high"}},
 {"node":{"asset_type":"WILDCARD","asset_identifier":"*.api.example.com","eligible_for_bounty":true,"max_severity":"critical"}},
 {"node":{"asset_type":"URL","asset_identifier":"one.example.com","eligible_for_bounty":true,"max_severity":"critical"}},
 {"node":{"asset_type":"URL","asset_identifier":"https://pathonly.example.net/api/*","eligible_for_bounty":true,"max_severity":"critical"}},
 {"node":{"asset_type":"WILDCARD","asset_identifier":"internal.*.example.com","eligible_for_bounty":false,"max_severity":"none"}},
 {"node":{"asset_type":"URL","asset_identifier":"legacy.example.com","eligible_for_bounty":false,"max_severity":"none"}}
]}}}}
JSON

"$BUILD" "$TMP/raw.json" "$TMP/scope" --platform h1 >/dev/null || { echo "FAIL: scope_build errored"; exit 1; }

# expected counts: 4 in, 2 out
ic=$(grep -c . "$TMP/scope/in_scope.txt"); oc=$(grep -c . "$TMP/scope/out_of_scope.txt")
[ "$ic" = "4" ] && [ "$oc" = "2" ] || { echo "FAIL: counts in=$ic out=$oc (want 4/2)"; exit 1; }

pass=0; fail=0
ck(){ got=$("$CHECK" "$TMP/scope" "$1" 2>/dev/null | cut -f1);
  if [ "$got" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL %-40s got[%s] want[%s]\n' "$1" "$got" "$2"; fi; }

ck "one.example.com"                 IN               # exact host
ck "a.example.com"                   IN               # *.example.com
ck "a.b.example.com"                 IN               # nested wildcard
ck "x.api.example.com"               IN               # *.api.example.com
ck "example.com"                     UNLISTED         # apex not covered by *.example.com
ck "legacy.example.com"              OOS              # explicit OOS URL
ck "internal.eu.example.com"         OOS              # OOS wildcard beats *.example.com
ck "EVIL.EXAMPLE.COM.attacker.net"   UNLISTED         # look-alike suffix trick
ck "notexample.com"                  UNLISTED         # substring, not subdomain
ck "https://pathonly.example.net/api/x" IN            # path-scoped allowed
ck "https://pathonly.example.net/secret" PATH_RESTRICTED  # path-scoped denied
ck "gateway-api.somevendor.net"      UNLISTED         # company-owned-but-unlisted (the nutaku class)

# severity cap surfaced
sev=$("$CHECK" "$TMP/scope" "z.example.com" 2>/dev/null | cut -f3)
[ "$sev" = "high" ] || { echo "FAIL: severity cap z.example.com got[$sev] want[high]"; fail=$((fail+1)); }

if [ "$fail" = "0" ]; then echo "[scope_selftest] OK — $pass checks passed (build 4/2, gate $pass)"; exit 0
else echo "[scope_selftest] $fail FAILED, $pass passed"; exit 1; fi
