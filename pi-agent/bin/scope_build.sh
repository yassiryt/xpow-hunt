#!/usr/bin/env bash
# scope_build.sh — turn a platform scope API response into canonical allowlists.
#
# WHY: the model must NEVER hand-transcribe or "correct" scope in prose. This
# converts the raw API JSON straight into the files scope_check.sh enforces.
# The API response is the SOLE authority; re-run this instead of editing by hand.
#
# USAGE
#   scope_build.sh <api_json_file> <out_scope_dir> [--platform auto|h1|intigriti|bugcrowd]
#
# WRITES (into <out_scope_dir>/)
#   in_scope.txt      TYPE<TAB>identifier<TAB>severity     (eligible / in-scope assets)
#   out_of_scope.txt  TYPE<TAB>identifier<TAB>severity     (explicitly out-of-scope assets)
#   scope.json        normalized [{type,identifier,severity,in_scope}]
#   SOURCE.txt        provenance: source file, platform, timestamp, in/out counts
#
# Supported JSON shapes (auto-detected):
#   HackerOne GraphQL : .data.team.structured_scopes.edges[].node{asset_type,asset_identifier,eligible_for_bounty,max_severity}
#   HackerOne REST    : .data[].attributes{asset_type,asset_identifier,eligible_for_bounty,max_severity}
#   Intigriti         : .domains.content[]{endpoint|content,type,tier}  (tier "Out of scope" / tier.value==0 => out)
#   Bugcrowd          : .{targets|in_scope|out_of_scope}[]{name|uri,category} with .in_scope boolean per target
set -euo pipefail
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ $# -ge 2 ] || die "usage: scope_build.sh <api_json_file> <out_scope_dir> [--platform auto|h1|intigriti|bugcrowd]"
SRC="$1"; OUT="$2"; PLATFORM="auto"
[ "${3:-}" = "--platform" ] && PLATFORM="${4:-auto}"
[ -s "$SRC" ] || die "source JSON missing or empty: $SRC"
mkdir -p "$OUT"
command -v python3 >/dev/null 2>&1 || die "python3 required"

SRC="$SRC" OUT="$OUT" PLATFORM="$PLATFORM" python3 - <<'PY'
import json, os, sys, datetime
src, out, platform = os.environ["SRC"], os.environ["OUT"], os.environ["PLATFORM"]
data = json.load(open(src))

def detect(d):
    if isinstance(d, dict):
        if d.get("data",{}).get("team",{}).get("structured_scopes"): return "h1gql"
        if isinstance(d.get("data"), list): return "h1rest"
        inner = d.get("data") if isinstance(d.get("data"), dict) else {}
        if d.get("domains",{}).get("content") is not None or inner.get("domains",{}).get("content") is not None: return "intigriti"
        if any(k in d for k in ("targets","in_scope","out_of_scope","groups","scope")): return "bugcrowd"
        if any(k in inner for k in ("targets","in_scope","out_of_scope","groups","scope")): return "bugcrowd"
    if isinstance(d, list): return "h1rest_list"
    return "unknown"

plat = platform if platform!="auto" else detect(data)
# normalize coarse platform aliases; for HackerOne always shape-detect (gql vs rest)
_alias = platform.lower()
if _alias in ("intigriti",):
    plat = "intigriti"
elif _alias in ("bugcrowd","bc"):
    plat = "bugcrowd"
elif _alias in ("h1","hackerone","hackerone-gql","h1gql","h1rest","auto"):
    plat = detect(data)
rows = []  # (type, identifier, severity, in_scope_bool)

def add(t,i,s,inb):
    if not i: return
    rows.append((str(t or "URL"), str(i).strip(), str(s or "").strip(), bool(inb)))

if plat=="h1gql":
    for e in data["data"]["team"]["structured_scopes"]["edges"]:
        n=e["node"]; add(n.get("asset_type"), n.get("asset_identifier"), n.get("max_severity"), n.get("eligible_for_bounty"))
elif plat in ("h1rest","h1rest_list"):
    items = data if isinstance(data,list) else data.get("data",[])
    for it in items:
        a = it.get("attributes", it)
        add(a.get("asset_type"), a.get("asset_identifier"), a.get("max_severity"), a.get("eligible_for_bounty"))
elif plat=="intigriti":
    root = data if data.get("domains") is not None else data.get("data", data)
    for c in root["domains"]["content"]:
        ident = c.get("endpoint") or c.get("content") or c.get("value")
        tier = c.get("tier")
        tval = tier.get("value") if isinstance(tier,dict) else tier
        tname = tier.get("name") if isinstance(tier,dict) else tier
        inb = not (str(tval)=="0" or str(tname).strip().lower()=="out of scope")
        ctype = c.get("type")
        ctype = ctype.get("value") if isinstance(ctype,dict) else (ctype if isinstance(ctype,str) else "URL")
        add(ctype, ident, tname, inb)
elif plat=="bugcrowd":
    root = data.get("data", data) if isinstance(data, dict) else data
    def emit(lst, default_in):
        for t in (lst or []):
            inb = t.get("in_scope", default_in)
            add(t.get("category","URL"), t.get("name") or t.get("uri"), None, inb)
    if "targets" in root: emit(root["targets"], True)
    emit(root.get("in_scope"), True); emit(root.get("out_of_scope"), False)
    for g in root.get("groups",[]) or []:
        emit(g.get("targets"), g.get("in_scope",True))
    for s in root.get("scope",[]) or []:
        for t in s.get("targets",[]) or []:
            add(t.get("category","URL"), t.get("name") or t.get("uri"), None, s.get("inScope",True))
else:
    die=lambda m:(sys.stderr.write("ERROR: "+m+"\n"),sys.exit(1))
    die(f"unrecognized scope JSON shape (platform={plat}). Pass --platform explicitly.")

# de-dup, stable order: in-scope first then oos, alpha within
seen=set(); uniq=[]
for r in rows:
    k=(r[1].lower(), r[3])
    if k in seen: continue
    seen.add(k); uniq.append(r)
ins =sorted([r for r in uniq if r[3]], key=lambda r:r[1].lower())
oos =sorted([r for r in uniq if not r[3]], key=lambda r:r[1].lower())

def write_list(path, rs):
    with open(path,"w") as f:
        for t,i,s,_ in rs:
            f.write(f"{t}\t{i}\t{s}\n")
write_list(os.path.join(out,"in_scope.txt"), ins)
write_list(os.path.join(out,"out_of_scope.txt"), oos)
json.dump([{"type":t,"identifier":i,"severity":s,"in_scope":b} for t,i,s,b in uniq],
          open(os.path.join(out,"scope.json"),"w"), indent=2)
with open(os.path.join(out,"SOURCE.txt"),"w") as f:
    f.write(f"source_file: {src}\nplatform: {plat}\nbuilt_at: {datetime.datetime.now().isoformat()}\n")
    f.write(f"in_scope_count: {len(ins)}\nout_of_scope_count: {len(oos)}\n")
print(f"[scope_build] platform={plat}  in_scope={len(ins)}  out_of_scope={len(oos)}  -> {out}")
PY
