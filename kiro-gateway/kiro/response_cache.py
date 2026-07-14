"""
Response cache for Kiro Gateway (quota saver).

Kiro/CodeWhisperer enforces a *monthly request count* quota. This pure-ASGI
middleware caches successful responses keyed by the EXACT request (path + auth +
raw body), so an identical repeat request is served from memory with ZERO
upstream Kiro requests.

Why this is safe/stable:
- The cache key is the byte-exact request body, which fully determines the
  completion (model, full message history, system, tools, params, and the
  `stream` flag). Replaying the identical recorded response is always correct.
- Only HTTP 200 responses are cached; error/quota bodies are never cached.
- Works for streaming and non-streaming uniformly because it caches the raw
  response bytes. On a miss it passes bytes through untouched (streaming UX
  preserved) while teeing a copy; on a hit it replays the recorded bytes.

Enable with KIRO_RESPONSE_CACHE=1. Tune with KIRO_RESPONSE_CACHE_TTL (seconds,
default 3600) and KIRO_RESPONSE_CACHE_MAX (max entries, default 500).
"""

import hashlib
import os
import time

from loguru import logger


class ResponseCacheMiddleware:
    def __init__(self, app, paths=None):
        self.app = app
        self.paths = set(paths or ["/v1/messages", "/v1/chat/completions"])
        self.enabled = os.getenv("KIRO_RESPONSE_CACHE", "0") == "1"
        self.ttl = float(os.getenv("KIRO_RESPONSE_CACHE_TTL", "3600"))
        self.max_entries = int(os.getenv("KIRO_RESPONSE_CACHE_MAX", "500"))
        self.store = {}  # key -> (expiry_ts, status, headers, body_bytes)
        self.hits = 0
        self.misses = 0
        if self.enabled:
            logger.info(f"[response-cache] enabled (ttl={self.ttl}s, max={self.max_entries})")

    def _evict(self):
        now = time.time()
        for k in [k for k, v in self.store.items() if v[0] <= now]:
            self.store.pop(k, None)
        if len(self.store) > self.max_entries:
            for k in sorted(self.store, key=lambda k: self.store[k][0])[: len(self.store) - self.max_entries]:
                self.store.pop(k, None)

    async def __call__(self, scope, receive, send):
        if (
            not self.enabled
            or scope.get("type") != "http"
            or scope.get("method") != "POST"
            or scope.get("path") not in self.paths
        ):
            return await self.app(scope, receive, send)

        # Read the full request body (and remember the raw messages to replay).
        body = b""
        messages = []
        while True:
            m = await receive()
            messages.append(m)
            if m.get("type") == "http.request":
                body += m.get("body", b"")
                if not m.get("more_body", False):
                    break
            elif m.get("type") == "http.disconnect":
                break

        auth = ""
        for (h, v) in scope.get("headers", []):
            if h in (b"authorization", b"x-api-key"):
                auth = v.decode("latin1")
                break
        key = hashlib.sha256(scope["path"].encode() + b"\x00" + auth.encode() + b"\x00" + body).hexdigest()

        now = time.time()
        hit = self.store.get(key)
        if hit and hit[0] > now:
            self.hits += 1
            _, status, headers, cbody = hit
            logger.info(f"[response-cache] HIT {scope['path']} (0 upstream req; hits={self.hits} misses={self.misses})")
            await send({"type": "http.response.start", "status": status, "headers": headers})
            await send({"type": "http.response.body", "body": cbody, "more_body": False})
            return

        self.misses += 1
        it = iter(messages)
        exhausted = False

        async def receive2():
            nonlocal exhausted
            if not exhausted:
                try:
                    return next(it)
                except StopIteration:
                    exhausted = True
            # After the buffered body is fully replayed, delegate to the real
            # receive (yields http.disconnect when appropriate). Emitting another
            # http.request here breaks downstream BaseHTTPMiddleware.
            return await receive()

        cap = {"status": 200, "headers": [], "body": bytearray()}

        async def send2(message):
            t = message.get("type")
            if t == "http.response.start":
                cap["status"] = message["status"]
                cap["headers"] = message.get("headers", [])
            elif t == "http.response.body":
                cap["body"] += message.get("body", b"")
            await send(message)  # pass through unchanged (preserve streaming)

        await self.app(scope, receive2, send2)

        try:
            if cap["status"] == 200 and cap["body"]:
                bl = bytes(cap["body"])
                low = bl.lower()
                if (b'"type":"error"' in low) or (b"monthly request limit" in low) or (b'"api_error"' in low) or (b'"error":' in low):
                    return  # never cache error/quota responses
                self.store[key] = (now + self.ttl, cap["status"], cap["headers"], bl)
                self._evict()
        except Exception as e:
            logger.debug(f"[response-cache] store failed: {e}")
