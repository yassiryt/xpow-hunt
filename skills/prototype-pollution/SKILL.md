---
name: prototype-pollution
description: "JavaScript prototype pollution methodology: find client-side and server-side pollution sources, discover gadgets, and escalate to DOM XSS, auth/logic bypass, or RCE on Node. Auto-loads when the target is a Node/JS app, when JSON/query/merge inputs reach object properties, or when prototype-pollution-hunter is engaged."
---

# Prototype Pollution

Polluting `Object.prototype` makes a property appear on *every* object. Alone it's often nothing; with a gadget it becomes DOM XSS, auth bypass, or Node RCE. Deep work goes to `prototype-pollution-hunter`. Pairs with xss (client gadget → XSS), business-impact, safe-exploitation.

---

## 1. SOURCES (attacker-controlled property write)
Look for inputs that get merged/assigned into objects:
- **Client:** URL query/hash parsed into objects (`?__proto__[x]=y`, `?constructor[prototype][x]=y`), `location.hash` → deep-merge, `JSON.parse` → merge, libraries (jQuery `$.extend`, lodash `merge`/`set`/`defaultsDeep`, `deep-extend`, Angular/Vue). 
- **Server (Node):** JSON body deep-merged into config/options, query-string parsers (`qs`), `Object.assign` chains, ORM/user-object hydration.

Key payloads (the two prototype access paths):
```
__proto__[polluted]=yes
constructor[prototype][polluted]=yes     (bypasses __proto__ key filters)
{"__proto__":{"polluted":"yes"}}          (JSON body)
{"constructor":{"prototype":{"polluted":"yes"}}}
```

## 2. DETECT POLLUTION
- **Client:** in DevTools console after sending the payload, check `Object.prototype.polluted` / `({}).polluted === 'yes'`. Use DOM Invader (Burp) — it automates client PP source+gadget discovery.
- **Server:** send `{"__proto__":{"json spaces":10}}` (Express) → subsequent JSON responses become pretty-printed with 10 spaces (a classic server-PP oracle). Or `{"__proto__":{"status":510}}` / a param the framework reads from prototype → observe a global behavior change. Or set a property that reflects in a later response.

## 3. FIND THE GADGET (pollution → impact)
Pollution matters only if some code later reads the polluted property from a fresh object without its own value:
- **DOM XSS gadgets:** polluted props that flow into `innerHTML`, script `src`, template config, `srcdoc`, sanitizer options (e.g. polluting a sanitizer's allowed-tags/`ALLOWED_ATTR`), or a library's script-loading config. `__proto__[innerHTML]`, gadget in `sanitizer`/`template`/`config`.
- **Server gadgets → RCE:** pollute properties consumed by `child_process` spawn options (`shell`, `NODE_OPTIONS`, `env`), template engines (EJS/Handlebars/Pug `outputFunctionName`, `compile` options), or `require` paths. Classic: pollute `NODE_OPTIONS`/`--require` or EJS `settings['view options']` → RCE.
- **Auth/logic gadgets:** pollute `isAdmin`, `role`, `authenticated`, `verified`, feature flags read from a fresh object → privilege escalation / gate bypass.

Use the DOM Invader / published gadget lists per library+version; the gadget is version-specific, so fingerprint the JS libs first.

## 4. CONFIRM + ESCALATE
- Show pollution set the property AND the gadget fired (actual `alert(document.domain)` for DOM XSS, actual admin access for authz, `id`-class proof for RCE via oob-verification/safe-exploitation limits).
- Pollution without a reachable gadget = Low/Informational (say so honestly, evidence-discipline). Pollution + working gadget = the real finding; score by gadget impact (business-impact).

## 5. EVIDENCE
- Capture: the source request/URL with the payload, the pollution oracle proof (`json spaces` / console check), and the gadget firing (screenshot/response). Note the exact library+version that provided source and gadget.

## FALSE POSITIVES / DEAD-ENDS
- Property set on a single object instance (not the prototype) — not pollution.
- Modern Node/hardened libs (`Object.freeze(Object.prototype)`, null-proto objects, `--disable-proto`) block it — note as mitigated.
- Pollution with no gadget in the app's code path — real but usually Informational; do not over-claim RCE/XSS without the gadget proven.
