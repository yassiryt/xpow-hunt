---
name: api-graphql-methodology
description: "Systematic REST and GraphQL testing methodology for modern app backends: endpoint/verb/version enumeration, mass assignment, excessive data exposure, GraphQL introspection, alias batching, and federation SSRF. Auto-loads when an API or GraphQL endpoint is identified, or when JSON/GraphQL traffic is in scope."
---

# API & GraphQL Methodology

Modern criticals live in the API layer. This is the ordered method for covering a REST or GraphQL backend so nothing high-value is skipped. Route every object-reference authorization test to authz-matrix; use this skill for the API-specific surface around it.

---

## REST

### 1. Enumerate the surface
- Pull routes from JS bundles, `swagger.json`/`openapi.json`, `/api-docs`, `.well-known`, and proxy history.
- Test API **versions** side by side: `/v1` vs `/v2` vs `/v3` and undocumented `/internal`, `/beta`. Old versions often miss authz fixes present in new ones (improper inventory management).

### 2. Verb & content-type tampering
- Swap methods on each endpoint: `GET/POST/PUT/PATCH/DELETE`, `X-HTTP-Method-Override`. A read endpoint that also accepts `PUT`/`PATCH` may allow unauthorized writes.
- Switch content type: JSON vs form-encoded vs XML on the same endpoint — parser differentials expose injection and authz gaps.

### 3. Mass assignment / excessive data
- Add fields the client never sends: `"role":"admin"`, `"is_verified":true`, `"user_id":<other>`, `"price":0`, `"balance":9999`. Diff the response/state.
- Look for **excessive data exposure**: the API returns full objects (password hashes, internal flags, other users' fields) and the *client* hides them. Read the raw JSON, not the UI.

### 4. Pagination / filtering / sorting
- Abuse `limit`, `page_size`, `offset` for bulk pull. Test `sort=`/`order_by=`/`fields=` against hidden columns (`order_by=password_reset_token`) — an ORM leak / ordering oracle.

## GraphQL

### 1. Fingerprint & schema
- Locate: `/graphql`, `/graphiql`, `/v1/graphql`, `/api/graphql`, `/query`, `/playground`.
- Fingerprint the engine with `graphw00f` (Apollo/Hasura/graphql-yoga/etc.).
- **Introspection:** send the introspection query. If on → dump full schema (types, queries, mutations, args). If off → infer with `clairvoyance` and by field-suggestion error messages ("Did you mean ...").

### 2. Enumerate high-value operations
- Queries returning PII / tokens / reset codes / internal config.
- Mutations that change state: `updateUser`, `setRole`, `inviteMember`, `resetPassword`, `createApiKey`.
- Per-**field** authorization: a field may be unprotected even when the parent query is protected — test fields individually with different identities (authz-matrix).

### 3. GraphQL-specific attacks
- **Alias batching:** send many aliased copies in one request to bypass rate limits / brute OTPs/coupons:
  `{ a1:login(otp:"0000"){t} a2:login(otp:"0001"){t} ... }`
- **Batch/array queries** where supported (`[{query...},{query...}]`) for the same effect.
- **Injection through args:** SQLi/NoSQL/command payloads in argument values → route to the matching hunter.
- **Federation / arg-to-URL SSRF:** in federated schemas, args sometimes get concatenated into internal service URLs — fuzz `include*`/config-ish args with an OOB canary (oob-verification).
- **Depth/complexity:** deeply nested cyclic queries stress the server — probe for a complexity limit's *presence* as an info issue; do NOT run a DoS (safe-exploitation).

## Cross-cutting
- Auth: where is the token (header/cookie), is it validated per-endpoint/per-field, does an expired/none token still work?
- Always run the object-reference authorization differential (authz-matrix) on every id/node-id/export the API exposes.
- Capture raw request/response evidence; score with business-impact.
