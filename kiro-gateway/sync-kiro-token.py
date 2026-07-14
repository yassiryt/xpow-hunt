#!/usr/bin/env python3
"""Sync kiro-cli's live social token (sqlite) -> camelCase creds JSON for kiro-gateway.

kiro-cli stores the current token in ~/.local/share/kiro-cli/data.sqlite3
under auth_kv key 'kirocli:social:token' (snake_case). kiro-gateway's JSON
reader expects camelCase. Run this before/while running the gateway to keep
it on kiro-cli's freshest token.
"""
import sqlite3, json, os, sys

DB = os.path.expanduser("~/.local/share/kiro-cli/data.sqlite3")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kiro-creds.json")

def main():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        row = con.execute(
            "select value from auth_kv where key='kirocli:social:token'"
        ).fetchone()
    finally:
        con.close()
    if not row:
        sys.exit("no 'kirocli:social:token' row in sqlite auth_kv")
    d = json.loads(row[0])
    out = {
        "accessToken": d["access_token"],
        "refreshToken": d["refresh_token"],
        "expiresAt": d.get("expires_at"),
        "profileArn": d.get("profile_arn"),
        "authMethod": "social",
        "provider": d.get("provider", "google"),
    }
    fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(out, f)
    print(f"wrote {OUT} (expiresAt={out['expiresAt']}, profileArn={out['profileArn']})")

if __name__ == "__main__":
    main()
