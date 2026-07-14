#!/usr/bin/env bash
# scope_check.sh — deterministic in/out-of-scope classifier for xpow-hunt.
#
# WHY THIS EXISTS
#   Scope used to live as prose the model re-interpreted and "corrected" by hand.
#   That produced (a) testing of out-of-scope assets and (b) hallucinated prose
#   that discarded genuinely in-scope assets (see reports/indrive/scope-authoritative.md,
#   which wrongly declared ~39 API-eligible assets OOS). This script is the single
#   deterministic authority: it classifies a host/URL against the API-derived
#   allowlists and NO model prose may override it.
#
# USAGE
#   scope_check.sh <scope_dir> <url-or-host>
#   scope_check.sh <scope_dir> -            # read targets from stdin, one per line
#   echo "https://a.b.com/x" | scope_check.sh reports/indrive/scope -
#
#   <scope_dir> must contain in_scope.txt and out_of_scope.txt (produced by
#   scope_build.sh directly from the platform API — never hand-written).
#
# ALLOWLIST FILE FORMAT (in_scope.txt / out_of_scope.txt)
#   One asset per line. Blank lines and lines starting with '#' are ignored.
#   A line is EITHER:
#     - a bare identifier:            *.indrive.com   |  external.indrive.dev  |  terra-*.indriverapp.com
#     - a URL/path-scoped identifier: https://api-proxy.choco.kz/api/*
#     - a TAB-separated record:       URL<TAB>external.indrive.dev<TAB>critical   (TYPE<TAB>identifier<TAB>severity)
#   (The TAB form lets the file BE the raw API tsv; field 2 = identifier, field 3 = severity.)
#
# OUTPUT (one line) + EXIT CODE
#   IN\t<matched-rule>\t<severity>     exit 0   → in scope, safe to test
#   OOS\t<matched-rule>                exit 2   → explicitly out of scope, DO NOT TEST
#   PATH_RESTRICTED\t<host>\t<prefixes>exit 4   → host in scope only under specific path prefixes; this target's path is not among them
#   UNLISTED                           exit 3   → not in the program's declared scope (belonging to a company domain is NOT scope)
#   ERROR: <msg>                       exit 1
#
# SEMANTICS (the rules the model kept getting wrong)
#   - Explicit out-of-scope ALWAYS wins over in-scope (checked first).
#   - "Ends with a company root domain" is NOT in scope. Only an exact-host match
#     or a declared WILDCARD match counts.
#   - Wildcard '*' matches within the declared domain suffix only (label chars and
#     dots), so nested subdomains covered by '*.x' are IN, but the boundary to the
#     registered domain is never crossed and look-alikes (evil-x.com) never match.
#   - Path-scoped URL assets (https://host/prefix/*) require BOTH host match AND the
#     request path to start with an allowed prefix; the bare host is NOT in scope.

set -o pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: scope_check.sh <scope_dir> <url-or-host|->"
SCOPE_DIR="$1"; shift
IN_FILE="$SCOPE_DIR/in_scope.txt"
OOS_FILE="$SCOPE_DIR/out_of_scope.txt"
[ -d "$SCOPE_DIR" ] || die "scope dir not found: $SCOPE_DIR"
[ -f "$IN_FILE" ] || die "missing $IN_FILE (run scope_build.sh first)"
[ -f "$OOS_FILE" ] || : > /dev/null  # OOS file optional (some programs have none)

# --- extract identifier[/severity] from a raw line (handles TAB records) -------
_ident() { # $1=line -> prints "identifier<TAB>severity"
  local line="$1" id sev
  if printf '%s' "$line" | grep -q "$(printf '\t')"; then
    id=$(printf '%s' "$line" | cut -f2)
    sev=$(printf '%s' "$line" | cut -f3)
  else
    id="$line"; sev=""
  fi
  printf '%s\t%s' "$id" "$sev"
}

# --- split an identifier into host + path-prefix --------------------------------
# sets globals: P_HOST P_PATH (P_PATH empty = host-only rule)
_split_ident() {
  local id="$1"
  id="${id#http://}"; id="${id#https://}"
  if printf '%s' "$id" | grep -q '/'; then
    P_HOST="${id%%/*}"
    P_PATH="/${id#*/}"          # keep leading slash, includes trailing /* if present
  else
    P_HOST="$id"; P_PATH=""
  fi
  P_HOST="${P_HOST%%:*}"        # strip :port
  P_HOST="${P_HOST%.}"          # strip trailing dot
}

# --- does target host match a pattern host? (exact or wildcard) -----------------
_host_match() { # $1=target_host $2=pattern_host -> 0 match / 1 no
  local t="$1" p="$2"
  [ -n "$p" ] || return 1
  case "$p" in
    *'*'*)
      # build anchored regex: escape ., then * -> [a-z0-9.-]*
      local rx
      rx=$(printf '%s' "$p" | sed -e 's/[.]/\\./g' -e 's/[*]/[a-z0-9.-]*/g')
      [[ "$t" =~ ^${rx}$ ]] && return 0 || return 1
      ;;
    *)
      [ "$t" = "$p" ] && return 0 || return 1
      ;;
  esac
}

# --- normalize a target into T_HOST + T_PATH ------------------------------------
_norm_target() {
  local u="$1"
  u=$(printf '%s' "$u" | tr 'A-Z' 'a-z' | tr -d '[:space:]')
  u="${u#http://}"; u="${u#https://}"
  if printf '%s' "$u" | grep -q '/'; then
    T_HOST="${u%%/*}"; T_PATH="/${u#*/}"
  else
    T_HOST="$u"; T_PATH=""
  fi
  T_HOST="${T_HOST%%:*}"; T_HOST="${T_HOST%.}"
  T_HOST="${T_HOST#*@}"   # drop any userinfo
}

classify() {
  local target="$1"
  T_HOST=""; T_PATH=""; _norm_target "$target"
  [ -n "$T_HOST" ] && printf '%s' "$T_HOST" | grep -q '\.' || { printf 'UNLISTED\n'; return 3; }

  local line id sev
  # 1) explicit OUT-OF-SCOPE wins
  if [ -f "$OOS_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|\#*) continue;; esac
      IFS=$'\t' read -r id sev <<EOF
$(_ident "$line")
EOF
      _split_ident "$id"
      if _host_match "$T_HOST" "$P_HOST"; then
        printf 'OOS\t%s\n' "$id"; return 2
      fi
    done < "$OOS_FILE"
  fi

  # 2) IN-SCOPE (host-only or path-scoped). Track path-restricted near-misses.
  local pr_prefixes=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue;; esac
    IFS=$'\t' read -r id sev <<EOF
$(_ident "$line")
EOF
    _split_ident "$id"
    _host_match "$T_HOST" "$P_HOST" || continue
    if [ -z "$P_PATH" ]; then
      printf 'IN\t%s\t%s\n' "$id" "$sev"; return 0
    fi
    # path-scoped rule: compare prefixes
    local prefix="${P_PATH%\*}"          # strip trailing * -> "/api/"
    if [ -n "$T_PATH" ] && [ "${T_PATH#$prefix}" != "$T_PATH" ]; then
      printf 'IN\t%s\t%s\n' "$id" "$sev"; return 0
    fi
    pr_prefixes="$pr_prefixes $prefix"
  done < "$IN_FILE"

  if [ -n "$pr_prefixes" ]; then
    printf 'PATH_RESTRICTED\t%s\t%s\n' "$T_HOST" "$(printf '%s' "$pr_prefixes" | sed 's/^ //')"; return 4
  fi
  printf 'UNLISTED\n'; return 3
}

# --- main -----------------------------------------------------------------------
target="$1"
if [ "$target" = "-" ]; then
  rc=0
  while IFS= read -r t || [ -n "$t" ]; do
    [ -n "$t" ] || continue
    out=$(classify "$t"); r=$?
    printf '%s\t%s\n' "$t" "$out"
    [ $r -gt $rc ] && [ $r -ne 3 ] && rc=$r
  done
  exit 0
else
  classify "$target"; exit $?
fi
