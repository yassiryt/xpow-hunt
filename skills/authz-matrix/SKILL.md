---
name: authz-matrix
description: "Multi-identity differential testing that finds most modern API criticals: BOLA/IDOR, BFLA, vertical/horizontal privilege escalation, and cross-tenant isolation breaks. Provisions an identity set and runs A->B / B->A object-reference differentials with an unauthenticated control. Auto-loads as soon as authenticated or multi-tenant surface is in scope, and whenever an object reference (id, guid, node id, export URL) is discovered."
---

# Authorization Matrix

Broken object- and function-level authorization is the dominant source of API criticals, and it is ONLY findable by testing one identity's credentials against another identity's objects. Make multi-identity the default posture, not an afterthought.

The finding is simple and repeatable: **User A's token returns User B's data (or performs B's action) and the server responds 200 with the real object.** Celebrate the 200 — don't dismiss it.

Pairs with test-account-manager (provisioning), evidence-discipline (an empty/identical body is NOT a break), safe-exploitation (both accounts are yours), business-impact (cross-tenant/admin reach = critical tier).

---

## 1. PROVISION THE IDENTITY SET FIRST

As soon as auth is in scope, get `test-account-manager` to create and capture:

- **User A** and **User B** in the **same** tenant/org (horizontal).
- **Tenant 1** and **Tenant 2** — separate orgs (cross-tenant isolation).
- **Low-privilege** vs **admin/owner** in the same org (vertical), where roles exist.
- An **unauthenticated** client (no token) as the baseline control.

Write them to `reports/<program>/structured-recon/authz-matrix.json` and pass that path to every hunter:

```json
{
  "userA":   { "label":"A tenant1 member", "cookie":"...", "bearer":"...", "user_id":"1001", "org_id":"77", "role":"member" },
  "userB":   { "label":"B tenant1 member", "cookie":"...", "bearer":"...", "user_id":"1002", "org_id":"77", "role":"member" },
  "userC":   { "label":"C tenant2 member", "cookie":"...", "bearer":"...", "user_id":"2001", "org_id":"88", "role":"member" },
  "admin":   { "label":"tenant1 owner",    "cookie":"...", "bearer":"...", "user_id":"1000", "org_id":"77", "role":"owner" },
  "anon":    { "label":"unauthenticated" }
}
```

## 2. COLLECT OBJECT REFERENCES

Every one of these is a test target — enumerate them from recon/proxy history:
- Numeric/sequential IDs (`/orders/1042`, `?user_id=1001`)
- UUIDs/GUIDs (mutate last hex char), ULIDs, MongoID
- GraphQL global node IDs (often base64 `Type:id` — decode, swap, re-encode)
- Export/report/download URLs, invoice/attachment links, signed URLs
- Filenames, S3 keys, ticket/message/comment IDs
- Anything in a request body/JSON that names an object or owner

## 3. THE DIFFERENTIAL (run for EVERY reference)

Baseline then swap, one variable at a time:

1. As **A**, capture the legitimate request for A's object → note status + body.
2. **Swap the object ID to B's**, keep **A's** token → replay.
   - 200 + B's real data ⇒ **BOLA/IDOR (horizontal)**.
3. **Swap the token to B's**, keep **B's** object (control) → confirms B's object is normally B's.
4. Reverse: **B's token → A's object** (B->A) to rule out per-object quirks.
5. **Cross-tenant:** A (tenant1) → C's (tenant2) object ⇒ **tenant isolation break** (higher severity).
6. **Unauthenticated:** strip the token entirely → 200 with the object ⇒ unauth access (highest).
7. **Vertical (BFLA):** low-priv identity calls an admin-only function/endpoint (`POST /admin/*`, `role=admin` mass-assignment, state-changing mutations) ⇒ **function-level authz break**.

Run the object-reference set as a `swarm` (one cell per reference × idor-logic-hunter) for exhaustive, not opportunistic, coverage.

## 4. WHAT IS AND IS NOT A FINDING (read carefully)

A real break requires the **other identity's real object content** to come back (or the action to actually take effect). Confirm with evidence:
- **Finding:** 200 + B's distinct data (B's email, B's order total, B's document text) that differs from A's and matches what B sees.
- **NOT a finding (false positive):** empty body, identical/templated body across identities, a generic 200 with no object data, a redirect to login, or a 403/404. An "empty or identical body across roles" is explicitly rejected by the validity gate.
- Verify the returned object is genuinely B's by cross-checking against B's own authenticated view.

## 5. METHOD / VERB / PARAM VARIANTS

If a direct swap is blocked, retry the differential with:
- Different methods (GET vs POST vs PUT vs PATCH vs DELETE; `X-HTTP-Method-Override`).
- ID in a different location (path vs query vs body vs header vs JSON nested).
- Parameter pollution (`user_id=1001&user_id=1002`), array wrapping (`user_id[]=1002`), type juggling.
- Adding the victim's `org_id`/tenant header while keeping your token.
- Wrapped/renamed params (`userId` vs `user_id` vs `uid`).

## 6. EVIDENCE + IMPACT

Capture both requests (A-normal, A-with-B's-object) and both responses (redacted) to `files/`. In `impact.md`, state reach and scale: single user, any enumerable user (sequential ids + no rate limit = all users), cross-tenant, or admin. Map severity via business-impact and cap via scope-discipline.
