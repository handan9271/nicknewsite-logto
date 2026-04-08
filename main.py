"""
Nick Speaking Platform — Backend
- POST /api/login       账号密码登录，返回 session token
- POST /api/upgrade     DeepSeek 代理（需要有效 token），流式转发
- GET  /api/me          验证 token
- POST /api/logout      退出
- GET  /                返回前端 HTML
"""

import os, json, secrets, hashlib, time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import httpx
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Nick Speaking Platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── CONFIG ──────────────────────────────────────────────────────────────────

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE    = "https://api.deepseek.com/v1/chat/completions"

# Users: loaded from env var USERS_JSON or from users.json file
# Format: [{"username": "alice", "password_hash": "<sha256>", "display_name": "Alice"}]
# To generate a hash: import hashlib; hashlib.sha256("mypassword".encode()).hexdigest()
USERS_FILE = Path(os.getenv("USERS_FILE", "./users.json"))

def load_users() -> list:
    # Priority 1: USERS_JSON env var (JSON string)
    env_users = os.getenv("USERS_JSON")
    if env_users:
        try:
            return json.loads(env_users)
        except Exception:
            pass
    # Priority 2: users.json file
    if USERS_FILE.exists():
        with open(USERS_FILE, encoding="utf-8") as f:
            return json.load(f)
    return []

def hash_password(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()

# In-memory session store: {token: {username, display_name, expires_at}}
# Simple, no DB needed. Tokens expire in 7 days.
sessions: dict = {}
SESSION_TTL = 7 * 24 * 3600  # seconds

def create_session(username: str, display_name: str) -> str:
    token = secrets.token_urlsafe(32)
    sessions[token] = {
        "username": username,
        "display_name": display_name,
        "expires_at": time.time() + SESSION_TTL,
    }
    return token

def get_session(token: str) -> Optional[dict]:
    s = sessions.get(token)
    if not s:
        return None
    if s["expires_at"] < time.time():
        sessions.pop(token, None)
        return None
    return s

# ─── AUTH DEPENDENCY ──────────────────────────────────────────────────────────

def require_auth(request: Request) -> dict:
    token = request.cookies.get("nick_token") or request.headers.get("X-Nick-Token", "")
    s = get_session(token)
    if not s:
        raise HTTPException(status_code=401, detail="请先登录")
    return s

# ─── ROUTES ──────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str

@app.post("/api/login")
async def login(body: LoginRequest):
    users = load_users()
    pw_hash = hash_password(body.password)
    user = next((u for u in users
                 if u["username"].lower() == body.username.lower()
                 and u["password_hash"] == pw_hash), None)
    if not user:
        raise HTTPException(status_code=401, detail="账号或密码错误")
    token = create_session(user["username"], user.get("display_name", user["username"]))
    resp = JSONResponse({"ok": True, "display_name": user.get("display_name", user["username"])})
    resp.set_cookie(
        "nick_token", token,
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=os.getenv("SECURE_COOKIE", "false").lower() == "true",
    )
    return resp

@app.post("/api/logout")
async def logout(request: Request):
    token = request.cookies.get("nick_token", "")
    sessions.pop(token, None)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("nick_token")
    return resp

@app.get("/api/me")
async def me(session: dict = Depends(require_auth)):
    return {"username": session["username"], "display_name": session["display_name"]}

class UpgradeRequest(BaseModel):
    messages: list
    max_tokens: int = 1800
    temperature: float = 0.3
    stream: bool = True

@app.post("/api/upgrade")
async def upgrade(body: UpgradeRequest, session: dict = Depends(require_auth)):
    """Proxy to DeepSeek, forwarding stream back to client."""
    if not DEEPSEEK_API_KEY:
        raise HTTPException(status_code=500, detail="DEEPSEEK_API_KEY not configured")

    payload = {
        "model": "deepseek-chat",
        "messages": body.messages,
        "max_tokens": body.max_tokens,
        "temperature": body.temperature,
        "stream": True,
    }

    async def stream_gen():
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST", DEEPSEEK_BASE,
                headers={
                    "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=payload,
            ) as resp:
                async for chunk in resp.aiter_bytes():
                    yield chunk

    return StreamingResponse(stream_gen(), media_type="text/event-stream")

# ─── STATIC / FRONTEND ───────────────────────────────────────────────────────

static_dir = Path("./static")
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

@app.get("/")
async def index():
    html = static_dir / "index.html"
    if not html.exists():
        raise HTTPException(status_code=404, detail="Frontend not found")
    return FileResponse(str(html))

# ─── ENTRYPOINT ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
