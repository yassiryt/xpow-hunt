---
name: deserialization
description: "Insecure deserialization methodology: recognize serialized blobs per language, detect unsafe sinks, and reach RCE via known gadget chains, confirmed out-of-band and proven safely. Auto-loads on serialized cookies/tokens/params (Java/PHP/.NET/Python/Ruby/Node), or when deserialization-hunter is engaged."
---

# Insecure Deserialization

Untrusted serialized data reaching a deserializer is a straight path to RCE. Recognizing the blob is 80% of the work. Deep work goes to `deserialization-hunter`. Pairs with oob-verification (blind confirm), safe-exploitation (prove exec, don't weaponize), business-impact (Critical).

---

## 1. RECOGNIZE THE FORMAT (where serialized data hides: cookies, tokens, `state`/`data`/`redirect` params, viewstate, cache, message queues, file uploads)
- **Java:** base64 starting `rO0AB` (or hex `aced0005`); `Content-Type: application/x-java-serialized-object`. Also JSON libs (Jackson/`@class`, fastjson `@type`, XStream) and `readObject`.
- **PHP:** `O:8:"ClassName":...`, `a:2:{...}` (serialize()); `__wakeup`/`__destruct` magic methods; PHAR (`phar://` triggers metadata deser).
- **.NET:** `AAEAAAD/////` (BinaryFormatter base64), `__VIEWSTATE` (test MAC-off), `TypeNameHandling` in Json.NET, `LosFormatter`, `ObjectStateFormatter`.
- **Python:** pickle (`\x80\x04`/base64 `gASV`), `yaml.load` (unsafe), `jsonpickle`.
- **Ruby:** Marshal (`\x04\x08`), YAML (`--- !ruby/object`).
- **Node:** `node-serialize` (`_$$ND_FUNC$$_`), `funcster`.

## 2. DETECT THE UNSAFE SINK
- The value is deserialized server-side without type allow-listing. Tamper a byte → a deserialization error/stack trace (e.g. Java `InvalidClassException`, PHP `__PHP_Incomplete_Class`) confirms it's being deserialized and reveals the library/version.
- ViewState: if `__VIEWSTATE` MAC is disabled/known machineKey → forgeable.

## 3. REACH RCE VIA GADGETS (use the ecosystem tools)
- **Java:** `ysoserial` — pick a chain matching libs on the classpath (CommonsCollections1-7, Spring, Groovy, etc.). If classpath unknown, use a detection gadget (URLDNS) that only does a DNS lookup → confirm via `oob-verification` WITHOUT running code.
- **PHP:** build a POP chain from the app's own classes (`__destruct`/`__wakeup`); PHPGGC for framework gadgets (Laravel/Symfony/Monolog).
- **.NET:** `ysoserial.net` (TypeConfuseDelegate etc.); forge ViewState with the machineKey.
- **Python:** pickle `__reduce__` returning `(os.system,("...",))` — for proof use an OOB curl/nslookup, not a destructive command.
- **Ruby/Node:** universal gadgets for Marshal/`node-serialize`.

## 4. CONFIRM SAFELY
- Prefer a **DNS/HTTP-only** detection gadget (URLDNS / a callback command) so confirmation does not execute a real payload. A canary hit = confirmed deserialization RCE primitive.
- If you run a command gadget, run ONE benign proof (`id`/`nslookup <canary>`) and stop — no shells, no persistence (safe-exploitation).
- Capture: the original blob, the tampered/gadget request, and the OOB interaction log or `id` output. Impact (business-impact): Critical (RCE).

## FALSE POSITIVES / NOTES
- A serialized blob that is signed/HMAC'd and verified before deserialization (Rails `_session`, MAC-on ViewState) is NOT exploitable unless the key leaks — check first.
- An error on tamper proves deserialization occurs, but you still need a working gadget on the classpath for RCE — don't claim RCE from an error alone (evidence-discipline).
- JWT is NOT deserialization — route to auth-attack-patterns.
