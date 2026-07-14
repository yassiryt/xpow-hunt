import asyncio, os, httpx
os.environ.setdefault("KIRO_FOLLOW_CLI", "1")
from kiro.auth import KiroAuthManager, AuthType
from kiro.utils import get_kiro_headers

async def main():
    db = os.path.expanduser("~/.local/share/kiro-cli/data.sqlite3")
    am = KiroAuthManager(sqlite_db=db, region="us-east-1")
    am._load_credentials_from_sqlite(db)
    token = await am.get_access_token()
    headers = get_kiro_headers(am, token)
    params = {"origin": "AI_EDITOR"}
    if am.auth_type == AuthType.KIRO_DESKTOP and am.profile_arn:
        params["profileArn"] = am.profile_arn
    url = f"{am.q_host}/ListAvailableModels"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(url, headers=headers, params=params)
        print("HTTP", r.status_code)
        data = r.json()
        for m in data.get("models", []):
            tl = m.get("tokenLimits", {}) or {}
            print(f"{m.get('modelId',''):<22} in={tl.get('maxInputTokens')}  out={tl.get('maxOutputTokens')}")

asyncio.run(main())
