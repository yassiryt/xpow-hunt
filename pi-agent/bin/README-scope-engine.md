# xpow-hunt scope engine (deterministic scope enforcement)

These three scripts replace prose scope (which the model re-interpreted and
"corrected" by hand, causing both out-of-scope testing and hallucinated
shrinkage of real scope) with a single machine-checkable source of truth.

| Script | Purpose |
|---|---|
| `scope_build.sh` | Turn a platform scope **API response** (HackerOne GraphQL/REST, Intigriti, Bugcrowd) into canonical allowlists. The model never transcribes scope by hand. |
| `scope_check.sh` | Classify any host/URL against those allowlists: `IN` / `OOS` / `UNLISTED` / `PATH_RESTRICTED`. The enforcement gate every agent uses. |
| `scope_selftest.sh` | Offline regression test (no network/model). Run by installers and anytime. |

## Flow

```bash
# 1) scope loader saves the raw API JSON, then builds the allowlists:
scope_build.sh reports/<program>/scope/raw_api.json reports/<program>/scope --platform h1
#    -> writes in_scope.txt, out_of_scope.txt, scope.json, SOURCE.txt

# 2) every agent gates targets/findings through:
scope_check.sh reports/<program>/scope "https://host/path"
#    IN\t<rule>\t<severity>  (exit 0)   → testable; severity is a CAP
#    OOS\t<rule>             (exit 2)   → explicitly out of scope
#    PATH_RESTRICTED\t<host>\t<prefixes> (exit 4) → only listed path prefixes are in scope
#    UNLISTED               (exit 3)   → not in declared scope (company-owned ≠ in-scope)

# batch mode:
scope_check.sh reports/<program>/scope - < hosts.txt
```

## Rules encoded (the ones the model kept getting wrong)

- Explicit out-of-scope ALWAYS beats in-scope.
- "Ends with a company root domain" / "resolves in DNS" is **not** scope. Only an
  exact-host or declared-wildcard match is in scope.
- Wildcards are label/suffix-bounded: `*.x.com` covers `a.x.com` and `a.b.x.com`
  but never the apex `x.com` and never look-alikes like `evil-x.com`.
- Path-scoped URL assets (`https://host/prefix/*`) require host **and** an allowed
  path prefix; the bare host is not in scope.
- The matched line's `max_severity` is returned and must be treated as a cap.

## Authority precedence (enforced in the agent prompts)

The API-derived `in_scope.txt` / `out_of_scope.txt` are the SOLE authority. No
agent may hand-edit them or write a prose "authoritative"/"corrected" scope that
overrides them. The only way to change scope is to re-fetch from the platform API
and re-run `scope_build.sh`. (See `reports/indrive/scope-authoritative.md` for the
real-world bug this prevents: a confident prose "correction" that wrongly threw
~39 in-scope assets out of scope.)

## Verify

```bash
./scope_selftest.sh        # expect: [scope_selftest] OK
```
