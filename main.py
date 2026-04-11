"""
Nick Speaking Platform — Backend (Logto + Database Edition)
- GET  /auth/sign-in      Logto OAuth 登录
- GET  /auth/callback      Logto 回调
- GET  /auth/sign-out      Logto 登出
- GET  /api/me             当前用户信息（email, credits, username, display_name）
- POST /api/upgrade        DeepSeek 代理（流式转发）+ 积分检查
- POST /api/save-conversation  保存对话历史
- GET  /api/history        用户历史记录
- POST /api/room/create    创建多人房间
- GET  /api/room/{code}    查询房间状态
- WS   /ws/game/{code}     多人游戏 WebSocket
- GET  /health             健康检查
- GET  /                   主页
- GET  /guide              指南页
- GET  /game               游戏页
"""

import os, json, secrets, time, asyncio, string, random, logging, re
from pathlib import Path
from typing import Optional, Union
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from time import time as time_now

from fastapi import FastAPI, Request, HTTPException, Depends, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, Float, create_engine, func, or_
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from logto import LogtoClient, LogtoConfig, Storage
import httpx
from dotenv import load_dotenv

load_dotenv()

# ─── LOGGING ────────────────────────────────────────────────────────────────

DATA_STORAGE_PATH = os.getenv("DATA_STORAGE_PATH", "./data")
data_dir = Path(DATA_STORAGE_PATH)
logs_dir = data_dir / "logs"
logs_dir.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger(__name__)

# ─── APP ────────────────────────────────────────────────────────────────────

app = FastAPI(title="Nick Speaking Platform")

CORS_ORIGINS_STR = os.getenv("CORS_ORIGINS", "*")
CORS_ORIGINS = [o.strip() for o in CORS_ORIGINS_STR.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security headers
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# ─── CONFIG ─────────────────────────────────────────────────────────────────

# DeepSeek multi-key round-robin: comma-separated keys in env var
_deepseek_keys_raw = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_KEYS = [k.strip() for k in _deepseek_keys_raw.split(",") if k.strip()]
_deepseek_key_index = 0

def get_deepseek_key() -> str:
    global _deepseek_key_index
    if not DEEPSEEK_API_KEYS:
        return ""
    key = DEEPSEEK_API_KEYS[_deepseek_key_index % len(DEEPSEEK_API_KEYS)]
    _deepseek_key_index += 1
    return key

logger.info(f"Loaded {len(DEEPSEEK_API_KEYS)} DeepSeek API key(s)")
DEEPSEEK_BASE = "https://api.deepseek.com/v1/chat/completions"

LOGTO_ENDPOINT = os.getenv("LOGTO_ENDPOINT", "")
LOGTO_APP_ID = os.getenv("LOGTO_APP_ID", "")
LOGTO_APP_SECRET = os.getenv("LOGTO_APP_SECRET", "")
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")

# ─── RATE LIMITER ───────────────────────────────────────────────────────────

class SimpleRateLimiter:
    def __init__(self):
        self.requests = defaultdict(list)

    def is_allowed(self, key: str, limit_per_minute: int = 10) -> bool:
        """Check if a given key (IP or user ID) is within rate limit."""
        now = time_now()
        minute_ago = now - 60
        self.requests[key] = [t for t in self.requests[key] if t > minute_ago]
        if len(self.requests[key]) >= limit_per_minute:
            return False
        self.requests[key].append(now)
        return True

rate_limiter = SimpleRateLimiter()

def get_client_ip(request: Request) -> str:
    return (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or request.headers.get("x-real-ip", "")
            or request.client.host)

# ─── DATABASE ───────────────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    mysql_host = os.getenv("MYSQL_HOST")
    mysql_port = os.getenv("MYSQL_PORT")
    mysql_username = os.getenv("MYSQL_USERNAME")
    mysql_password = os.getenv("MYSQL_PASSWORD")
    mysql_database = os.getenv("MYSQL_DATABASE")
    if all([mysql_host, mysql_port, mysql_username, mysql_password, mysql_database]):
        DATABASE_URL = f"mysql+pymysql://{mysql_username}:{mysql_password}@{mysql_host}:{mysql_port}/{mysql_database}?charset=utf8mb4"
        logger.info("Using MySQL database from individual environment variables")
    else:
        DATABASE_URL = "sqlite:///./nick_speaking.db"
        logger.info("Using SQLite database (default)")

if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    engine = create_engine(DATABASE_URL)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    logto_user_id = Column(String(255), unique=True, nullable=False, index=True)
    email = Column(String(255), index=True)
    display_name = Column(String(255), default="")
    role = Column(String(20), default="student")  # admin / teacher / student
    credits = Column(Integer, default=20)
    is_disabled = Column(Boolean, default=False)
    is_vip = Column(Boolean, default=False)
    starting_band = Column(Float, default=0)  # band when joined
    current_band = Column(Float, default=0)   # current evaluated band
    target_band = Column(Float, default=0)    # goal band
    exam_date = Column(DateTime, nullable=True)
    last_active_at = Column(DateTime, default=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)


class Conversation(Base):
    __tablename__ = "conversations"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    question = Column(Text)
    user_input = Column(Text)
    ai_reply = Column(Text)
    topic_type = Column(String(10), default="")
    score = Column(String(20), default="")
    timestamp = Column(DateTime, default=datetime.utcnow)


class GameSession(Base):
    __tablename__ = "game_sessions"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    logto_user_id = Column(String(255), nullable=False, index=True)
    room_code = Column(String(10), default="")
    mode = Column(String(20), default="solo")  # solo / multiplayer
    answers_json = Column(Text)       # JSON: [{part, question, answer, scores}]
    verdict_json = Column(Text)       # JSON: {scores, overall, verdict, comment}
    overall_score = Column(String(10), default="")
    rank = Column(Integer, default=0)
    player_count = Column(Integer, default=1)
    timestamp = Column(DateTime, default=datetime.utcnow)


class TeacherStudent(Base):
    __tablename__ = "teacher_students"
    id = Column(Integer, primary_key=True, index=True)
    teacher_id = Column(Integer, nullable=False, index=True)
    student_id = Column(Integer, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Announcement(Base):
    __tablename__ = "announcements"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255))
    content = Column(Text)
    target_role = Column(String(20), default="all")  # all, student, teacher, admin
    active = Column(Boolean, default=True)
    created_by = Column(Integer)
    created_at = Column(DateTime, default=datetime.utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, index=True)
    admin_id = Column(Integer, index=True)
    admin_email = Column(String(255))
    action = Column(String(100))
    target_type = Column(String(50))
    target_id = Column(Integer, default=0)
    details = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class Classroom(Base):
    __tablename__ = "classes"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255))
    teacher_id = Column(Integer, index=True)
    description = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class ClassStudent(Base):
    __tablename__ = "class_students"
    id = Column(Integer, primary_key=True, index=True)
    class_id = Column(Integer, index=True)
    student_id = Column(Integer, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class ContentItem(Base):
    __tablename__ = "content_items"
    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(100), unique=True, index=True)  # 'sample_food', 'prompt_meta', etc
    kind = Column(String(20), default="sample")  # sample / prompt / question
    content = Column(Text)
    updated_at = Column(DateTime, default=datetime.utcnow)
    updated_by = Column(Integer, default=0)


class LearningReport(Base):
    __tablename__ = "learning_reports"
    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, nullable=False, index=True)
    teacher_id = Column(Integer, nullable=False, index=True)
    title = Column(String(255), default="学习报告")
    content = Column(Text)
    band_at_time = Column(Float, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class Milestone(Base):
    __tablename__ = "milestones"
    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, nullable=False, index=True)
    from_band = Column(Float, default=0)
    to_band = Column(Float, default=0)
    notes = Column(Text, default="")
    created_by = Column(Integer, default=0)  # teacher who marked it
    achieved_at = Column(DateTime, default=datetime.utcnow)


class StudyPlan(Base):
    __tablename__ = "study_plans"
    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, nullable=False, index=True)
    teacher_id = Column(Integer, nullable=False, index=True)
    title = Column(String(255), default="学习计划")
    target_band = Column(Float, default=0)
    exam_date = Column(DateTime, nullable=True)
    content = Column(Text)
    status = Column(String(20), default="active")  # active / completed / archived
    created_at = Column(DateTime, default=datetime.utcnow)


class UserSession(Base):
    __tablename__ = "user_sessions"
    id = Column(Integer, primary_key=True, index=True)
    session_key = Column(String(255), unique=True, nullable=False, index=True)
    session_value = Column(Text, nullable=False)
    user_id = Column(String(255), index=True)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─── LOGTO SESSION STORAGE ──────────────────────────────────────────────────

class DatabaseSessionStorage(Storage):
    def __init__(self, db_session_factory=SessionLocal):
        self._cache = {}
        self._db_session_factory = db_session_factory
        self._cache_ttl = 300
        self._last_cleanup = time_now()

    def _get_db(self):
        return self._db_session_factory()

    def _cleanup_expired_cache(self):
        now = time_now()
        if now - self._last_cleanup > 60:
            expired = [k for k, (v, ts) in self._cache.items() if now - ts > self._cache_ttl]
            for k in expired:
                del self._cache[k]
            self._last_cleanup = now

    def get(self, key: str) -> Union[str, None]:
        try:
            self._cleanup_expired_cache()
            if key in self._cache:
                value, ts = self._cache[key]
                if time_now() - ts < self._cache_ttl:
                    return value
                else:
                    del self._cache[key]
            db = self._get_db()
            try:
                session = db.query(UserSession).filter(
                    UserSession.session_key == key,
                    UserSession.expires_at > datetime.utcnow()
                ).first()
                if session:
                    self._cache[key] = (session.session_value, time_now())
                    return session.session_value
                return None
            finally:
                db.close()
        except Exception as e:
            logger.error(f"Failed to get session {key}: {e}")
            if key in self._cache:
                return self._cache[key][0]
            return None

    def set(self, key: str, value: str) -> None:
        try:
            self._cache[key] = (value, time_now())
            db = self._get_db()
            try:
                expires_at = datetime.utcnow() + timedelta(hours=24)
                session = db.query(UserSession).filter(UserSession.session_key == key).first()
                if session:
                    session.session_value = value
                    session.expires_at = expires_at
                    session.updated_at = datetime.utcnow()
                else:
                    session = UserSession(
                        session_key=key, session_value=value, expires_at=expires_at
                    )
                    db.add(session)
                db.commit()
            finally:
                db.close()
        except Exception as e:
            logger.error(f"Failed to set session {key}: {e}")

    def delete(self, key: str) -> None:
        try:
            self._cache.pop(key, None)
            db = self._get_db()
            try:
                db.query(UserSession).filter(UserSession.session_key == key).delete()
                db.commit()
            finally:
                db.close()
        except Exception as e:
            logger.error(f"Failed to delete session {key}: {e}")


session_storage = DatabaseSessionStorage()

logto_config = LogtoConfig(
    endpoint=LOGTO_ENDPOINT,
    appId=LOGTO_APP_ID,
    appSecret=LOGTO_APP_SECRET,
    scopes=["openid", "profile", "email"],
) if LOGTO_ENDPOINT and LOGTO_APP_ID and LOGTO_APP_SECRET else None

# ─── AUTH HELPERS ───────────────────────────────────────────────────────────

def get_base_url(request: Request) -> str:
    if BASE_URL != "http://localhost:8000":
        return BASE_URL.rstrip('/')
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.netloc))
    return f"{scheme}://{host}".rstrip('/')


async def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Get current authenticated user from Logto session."""
    if not logto_config:
        raise HTTPException(status_code=500, detail="Logto not configured")

    client = LogtoClient(logto_config, storage=session_storage)

    if not client.isAuthenticated():
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_info = await client.fetchUserInfo()
    logto_user_id = user_info.sub
    email = getattr(user_info, 'email', None) or ""
    name = getattr(user_info, 'name', None) or (email.split("@")[0] if email else "User")

    db_user = db.query(User).filter(User.logto_user_id == logto_user_id).first()
    if not db_user:
        db_user = User(logto_user_id=logto_user_id, email=email, display_name=name)
        db.add(db_user)
        db.commit()
        db.refresh(db_user)
        logger.info(f"New user created: {email}")

    # Block disabled users
    if db_user.is_disabled:
        raise HTTPException(status_code=403, detail="您的账号已被禁用，请联系管理员")

    # Update display_name if changed
    if name and db_user.display_name != name:
        db_user.display_name = name
    # Update last_active_at (throttle to 5 min to avoid too many writes)
    now = datetime.utcnow()
    if not db_user.last_active_at or (now - db_user.last_active_at).total_seconds() > 300:
        db_user.last_active_at = now
    db.commit()

    return db_user


# ─── DEEPSEEK SHARED HELPER ────────────────────────────────────────────────

async def call_deepseek(messages: list, max_tokens: int = 1800, temperature: float = 0.5) -> str:
    """Call DeepSeek API and return the full text response."""
    api_key = get_deepseek_key()
    if not api_key:
        raise Exception("DEEPSEEK_API_KEY not configured")
    payload = {
        "model": "deepseek-chat",
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
    }
    buf = ''
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST", DEEPSEEK_BASE,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        ) as resp:
            async for chunk in resp.aiter_text():
                for line in chunk.split('\n'):
                    if not line.startswith('data: '):
                        continue
                    d = line[6:].strip()
                    if d == '[DONE]':
                        continue
                    try:
                        content = json.loads(d).get('choices', [{}])[0].get('delta', {}).get('content', '')
                        buf += content
                    except Exception:
                        pass
    return buf


def parse_json_response(raw: str) -> dict | None:
    clean = re.sub(r'^```json\s*|^```\s*|```\s*$', '', raw, flags=re.MULTILINE).strip()
    try:
        return json.loads(clean)
    except Exception:
        m = re.search(r'\{[\s\S]*\}', clean)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return None


# ─── MULTIPLAYER: DATA STRUCTURES ───────────────────────────────────────────

@dataclass
class Player:
    username: str
    display_name: str
    ws: WebSocket
    answers: list = field(default_factory=list)
    final_verdict: dict | None = None
    connected: bool = True

@dataclass
class Room:
    code: str
    host: str
    players: dict = field(default_factory=dict)
    status: str = 'lobby'
    phase: str = ''
    questions_part1: list = field(default_factory=list)
    part2_topic: dict = field(default_factory=dict)
    part3_questions: list = field(default_factory=list)
    q_index: int = 0
    timer_end: float = 0.0
    answers_received: set = field(default_factory=set)
    ready_received: set = field(default_factory=set)
    current_part: int = 1
    current_question: str = ''
    game_task: asyncio.Task | None = None

rooms: dict[str, Room] = {}

def generate_room_code() -> str:
    chars = string.ascii_uppercase + string.digits
    while True:
        code = ''.join(random.choices(chars, k=4))
        if code not in rooms:
            return code

async def broadcast(room: Room, msg: dict, exclude: str | None = None):
    data = json.dumps(msg)
    for p in room.players.values():
        if p.connected and p.username != exclude:
            try:
                await p.ws.send_text(data)
            except Exception:
                p.connected = False

async def send_to(player: Player, msg: dict):
    try:
        await player.ws.send_text(json.dumps(msg))
    except Exception:
        player.connected = False

def room_state_msg(room: Room) -> dict:
    return {
        'type': 'room_state',
        'code': room.code,
        'players': [{'username': p.username, 'display_name': p.display_name} for p in room.players.values()],
        'host': room.host,
        'status': room.status,
    }


# ─── MULTIPLAYER: AI PROMPTS ───────────────────────────────────────────────

EXAMINER_PROMPT_SERVER = """You are Nick, a former IELTS examiner acting as a judge in a courtroom-themed IELTS speaking test. You are dramatic, intimidating but fair.

CRITICAL RULES for your reaction:
- You MUST actually evaluate the student's answer content, vocabulary, grammar, and relevance to the question.
- If the answer is short, vague, off-topic, or uses only basic vocabulary → react with "disappointed" or "concerned". Be stern.
- If the answer has grammar errors → trigger an objection with the specific error.
- If the answer is detailed, uses good vocabulary, and addresses the question well → react with "satisfied" or "impressed".
- NEVER say "interesting" or "impressive" to a weak or generic answer.
- Your comment MUST reference specific things the student said (or failed to say).

Respond ONLY with this JSON (no markdown, no extra text):
{
  "reaction": "satisfied|concerned|impressed|disappointed|shocked",
  "comment": "1-2 sentence reaction referencing the SPECIFIC content of the answer.",
  "objection": null,
  "scores": {"FC": 1-9, "LR": 1-9, "GRA": 1-9, "Pron": 6}
}

Or if there's a grammar/vocabulary issue:
{
  "reaction": "concerned",
  "comment": "Your reaction",
  "objection": {"reason": "The specific error you found"},
  "scores": {"FC": 1-9, "LR": 1-9, "GRA": 1-9, "Pron": 6}
}

Score guide: 4=weak, 5=limited, 6=competent, 7=good, 8=very good, 9=expert."""

VERDICT_PROMPT_SERVER = """You are Judge Nick delivering the final verdict of an IELTS courtroom trial.

Base scores strictly on the actual quality of ALL answers below. Evaluate:
- FC (Fluency & Coherence): Full development & coherence
- LR (Lexical Resource): Vocabulary variety & precision
- GRA (Grammatical Range & Accuracy): Complex sentences & accuracy
- Pron: Default 6.

Score guide: 4=weak, 5=limited, 6=competent, 7=good, 8=very good, 9=expert.
Overall = average rounded to nearest 0.5.

Respond ONLY with this JSON:
{
  "scores": {"FC": number, "LR": number, "GRA": number, "Pron": number},
  "overall": number,
  "verdict": "Dramatic 1-2 sentence verdict",
  "comment": "Detailed feedback citing specific examples",
  "reaction": "merciful|harsh|impressed|disappointed"
}"""


async def score_answer_server(answer: str, question: str, part: int) -> dict:
    try:
        extra = '\nThis is Part 3 cross-examination. Be more critical.' if part == 3 else ''
        raw = await call_deepseek([
            {'role': 'system', 'content': EXAMINER_PROMPT_SERVER},
            {'role': 'user', 'content': f'Part {part} question.\nQuestion: "{question}"\nStudent\'s answer: "{answer}"{extra}'},
        ])
        result = parse_json_response(raw)
        if result and 'scores' in result:
            return result
    except Exception:
        pass
    words = len(answer.split())
    fc = min(max(4, 5 + (words - 20) // 20), 8)
    lr = min(max(4, 5 + (len(set(answer.lower().split())) - 10) // 8), 8)
    gra = 5 if words < 30 else 6
    return {
        'reaction': 'concerned' if words < 30 else 'satisfied',
        'comment': 'The court notes your testimony.' if words < 30 else 'The court acknowledges your response.',
        'objection': None,
        'scores': {'FC': fc, 'LR': lr, 'GRA': gra, 'Pron': 6},
    }


async def compute_verdict_server(answers: list) -> dict:
    try:
        answers_text = '\n\n'.join(
            f'[Part {a["part"]}] Q: {a["question"]}\nA: {a["answer"]}' for a in answers
        )
        raw = await call_deepseek([
            {'role': 'system', 'content': VERDICT_PROMPT_SERVER},
            {'role': 'user', 'content': f'All answers:\n\n{answers_text}\n\nDeliver the verdict.'},
        ])
        result = parse_json_response(raw)
        if result and 'scores' in result:
            return result
    except Exception:
        pass
    all_scores = [a.get('scores', {}) for a in answers if a.get('scores')]
    if all_scores:
        avg = lambda k: round(sum(s.get(k, 5) for s in all_scores) / len(all_scores))
        fc, lr, gra, pron = avg('FC'), avg('LR'), avg('GRA'), 6
        overall = round(((fc + lr + gra + pron) / 4) * 2) / 2
    else:
        fc, lr, gra, pron, overall = 5, 5, 5, 6, 5.5
    return {
        'scores': {'FC': fc, 'LR': lr, 'GRA': gra, 'Pron': pron},
        'overall': overall,
        'verdict': 'The court has reached its judgment.',
        'comment': 'Assessment based on available testimony.',
        'reaction': 'impressed' if overall >= 7 else 'merciful' if overall >= 6 else 'disappointed',
    }


# ─── MULTIPLAYER GAME LOOP ─────────────────────────────────────────────────

async def run_game_loop(room: Room):
    try:
        part1_pool = [
            "Let's talk about your hometown. What do you like most about it?",
            "Do you work or are you a student? Tell me about it.",
            "What do you usually do in your free time?",
            "How often do you use the internet? What for?",
            "Do you like cooking? Why or why not?",
            "Tell me about a festival that is important in your country.",
            "What kind of music do you enjoy listening to?",
            "Do you prefer reading books or watching movies?",
        ]
        random.shuffle(part1_pool)
        room.questions_part1 = part1_pool[:4]

        part2_topics = [
            {'topic': 'Describe a time when you had to speak in front of a group of people.',
             'points': ['When it was', 'Who you were speaking to', 'What you spoke about', 'How you felt about it']},
            {'topic': 'Describe a place you have visited that you found particularly beautiful.',
             'points': ['Where it was', 'When you went there', 'What it looked like', 'Why you found it beautiful']},
            {'topic': 'Describe a person who has had a significant influence on your life.',
             'points': ['Who this person is', 'How you know them', 'What they have done', 'Why they have influenced you']},
        ]
        room.part2_topic = random.choice(part2_topics)

        room.part3_questions = [
            "Why do you think this topic is important to society?",
            "How has this changed compared to the past?",
            "What do you think will happen in the future regarding this?",
        ]

        room.status = 'playing'

        await broadcast(room, {
            'type': 'game_start',
            'questions_part1': room.questions_part1,
            'part2_topic': room.part2_topic,
        })

        await broadcast(room, {
            'type': 'phase_change', 'phase': 'intro',
            'part': 0, 'q_index': 0, 'question': '', 'time_limit': 0,
        })
        await wait_all_ready(room, timeout=15)

        # Part 1
        room.current_part = 1
        for qi in range(4):
            room.q_index = qi
            q = room.questions_part1[qi]
            room.current_question = q
            room.answers_received = set()
            await broadcast(room, {
                'type': 'phase_change', 'phase': 'part1',
                'part': 1, 'q_index': qi, 'question': q, 'time_limit': 45,
            })
            room.timer_end = time_now() + 45
            await run_timer(room, 45)
            await broadcast(room, {'type': 'timer_end'})
            await asyncio.sleep(1)
            await score_all_answers(room, q, 1)
            await wait_all_ready(room, timeout=10)

        # Part 2
        room.current_part = 2
        room.q_index = 0
        room.answers_received = set()
        await broadcast(room, {
            'type': 'phase_change', 'phase': 'part2-prep',
            'part': 2, 'q_index': 0, 'question': room.part2_topic['topic'],
            'time_limit': 60, 'part2_topic': room.part2_topic,
        })
        room.timer_end = time_now() + 60
        await run_timer(room, 60)
        await broadcast(room, {'type': 'timer_end'})

        room.current_question = room.part2_topic['topic']
        await broadcast(room, {
            'type': 'phase_change', 'phase': 'part2-speak',
            'part': 2, 'q_index': 0, 'question': room.part2_topic['topic'], 'time_limit': 120,
        })
        room.timer_end = time_now() + 120
        await run_timer(room, 120)
        await broadcast(room, {'type': 'timer_end'})
        await asyncio.sleep(1)
        await score_all_answers(room, room.part2_topic['topic'], 2)
        await wait_all_ready(room, timeout=10)

        # Part 3
        room.current_part = 3
        for qi in range(3):
            room.q_index = qi
            q = room.part3_questions[qi]
            room.current_question = q
            room.answers_received = set()
            await broadcast(room, {
                'type': 'phase_change', 'phase': 'part3',
                'part': 3, 'q_index': qi, 'question': q, 'time_limit': 60,
            })
            room.timer_end = time_now() + 60
            await run_timer(room, 60)
            await broadcast(room, {'type': 'timer_end'})
            await asyncio.sleep(1)
            await score_all_answers(room, q, 3)
            await wait_all_ready(room, timeout=10)

        # Final verdict
        room.status = 'scoring'
        await broadcast(room, {
            'type': 'phase_change', 'phase': 'scoring',
            'part': 0, 'q_index': 0, 'question': '', 'time_limit': 0,
        })

        verdict_tasks = {}
        for username, player in room.players.items():
            if player.connected:
                verdict_tasks[username] = asyncio.create_task(compute_verdict_server(player.answers))

        leaderboard = []
        for username, task in verdict_tasks.items():
            try:
                v = await task
            except Exception:
                v = {'scores': {'FC': 5, 'LR': 5, 'GRA': 5, 'Pron': 6}, 'overall': 5.5,
                     'verdict': 'Assessment unavailable.', 'comment': '', 'reaction': 'disappointed'}
            player = room.players[username]
            player.final_verdict = v
            leaderboard.append({
                'username': username, 'display_name': player.display_name,
                'scores': v['scores'], 'overall': v['overall'],
                'verdict': v.get('verdict', ''), 'comment': v.get('comment', ''),
            })

        leaderboard.sort(key=lambda x: x['overall'], reverse=True)
        for i, entry in enumerate(leaderboard):
            entry['rank'] = i + 1
            entry['verdict_label'] = 'NOT GUILTY' if i == 0 else 'GUILTY'

        room.status = 'done'
        await broadcast(room, {'type': 'verdict_result', 'leaderboard': leaderboard})

        # Save game sessions to database
        try:
            db = SessionLocal()
            for entry in leaderboard:
                username = entry['username']
                player = room.players.get(username)
                if not player:
                    continue
                # Find user in database
                db_user = db.query(User).filter(User.logto_user_id == username).first()
                user_id = db_user.id if db_user else 0

                game_session = GameSession(
                    user_id=user_id,
                    logto_user_id=username,
                    room_code=room.code,
                    mode='multiplayer' if len(room.players) > 1 else 'solo',
                    answers_json=json.dumps(player.answers, ensure_ascii=False),
                    verdict_json=json.dumps(player.final_verdict, ensure_ascii=False) if player.final_verdict else '{}',
                    overall_score=str(entry.get('overall', '')),
                    rank=entry.get('rank', 0),
                    player_count=len(room.players),
                )
                db.add(game_session)
            db.commit()
            logger.info(f"[Room {room.code}] Saved {len(leaderboard)} game sessions to database")
            db.close()
        except Exception as save_err:
            logger.error(f"[Room {room.code}] Failed to save game sessions: {save_err}")

    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error(f"[Room {room.code}] Game loop error: {e}")
        try:
            await broadcast(room, {'type': 'error', 'message': 'Game error occurred.'})
        except Exception:
            pass


async def run_timer(room: Room, seconds: int):
    for elapsed in range(seconds):
        await asyncio.sleep(1)
        remaining = seconds - elapsed - 1
        if remaining >= 0 and remaining % 5 == 0:
            await broadcast(room, {'type': 'timer_sync', 'remaining': remaining})
        connected = {u for u, p in room.players.items() if p.connected}
        if connected and room.answers_received >= connected:
            break


async def wait_all_ready(room: Room, timeout: int = 10):
    room.ready_received = set()
    deadline = time_now() + timeout
    while time_now() < deadline:
        connected = {u for u, p in room.players.items() if p.connected}
        if connected and room.ready_received >= connected:
            break
        await asyncio.sleep(0.3)


async def score_all_answers(room: Room, question: str, part: int):
    tasks = {}
    for username, player in room.players.items():
        if not player.connected:
            continue
        answer_text = '(No answer provided)'
        for a in reversed(player.answers):
            if a.get('question') == question and a.get('part') == part:
                answer_text = a.get('answer', answer_text)
                break
        else:
            player.answers.append({'part': part, 'question': question, 'answer': answer_text})
        tasks[username] = asyncio.create_task(score_answer_server(answer_text, question, part))

    for username, task in tasks.items():
        try:
            result = await task
        except Exception:
            result = {'reaction': 'concerned', 'comment': 'The court could not evaluate.',
                      'objection': None, 'scores': {'FC': 5, 'LR': 5, 'GRA': 5, 'Pron': 6}}

        player = room.players.get(username)
        if not player:
            continue

        for a in reversed(player.answers):
            if a.get('question') == question and a.get('part') == part:
                a['scores'] = result.get('scores')
                break

        await send_to(player, {
            'type': 'ai_feedback',
            'reaction': result.get('reaction', 'neutral'),
            'comment': result.get('comment', ''),
            'objection': result.get('objection'),
            'scores': result.get('scores'),
        })

    await broadcast(room, {'type': 'all_feedback_done'})


# ─── WEBSOCKET AUTH HELPER ──────────────────────────────────────────────────

def ws_get_user_from_logto() -> Optional[dict]:
    """Try to get user info from Logto session storage (for WebSocket auth)."""
    if not logto_config:
        return None
    client = LogtoClient(logto_config, storage=session_storage)
    if not client.isAuthenticated():
        return None
    # We can't call async fetchUserInfo here, so we parse from storage
    # The Logto SDK stores id_token_claims in the session
    try:
        id_token = client.getIdTokenClaims()
        if id_token:
            return {
                "username": id_token.sub,
                "display_name": getattr(id_token, 'name', None) or getattr(id_token, 'email', None) or id_token.sub,
                "logto_user_id": id_token.sub,
            }
    except Exception as e:
        logger.error(f"WS auth error: {e}")
    return None


# ─── AUTH ROUTES ────────────────────────────────────────────────────────────

@app.get("/auth/sign-in")
async def sign_in(request: Request):
    if not logto_config:
        raise HTTPException(status_code=500, detail="Logto not configured")
    client = LogtoClient(logto_config, storage=session_storage)
    base_url = get_base_url(request)
    redirect_uri = os.getenv("LOGTO_REDIRECT_URI", f"{base_url}/auth/callback")
    sign_in_url = await client.signIn(redirectUri=redirect_uri)
    return RedirectResponse(sign_in_url)


@app.get("/auth/callback")
async def auth_callback(request: Request):
    if not logto_config:
        raise HTTPException(status_code=500, detail="Logto not configured")
    client = LogtoClient(logto_config, storage=session_storage)
    try:
        await client.handleSignInCallback(str(request.url))
        return RedirectResponse("/")
    except Exception as e:
        logger.error(f"Auth callback error: {e}")
        raise HTTPException(status_code=500, detail="Authentication failed")


@app.get("/auth/sign-out")
async def sign_out(request: Request):
    if not logto_config:
        raise HTTPException(status_code=500, detail="Logto not configured")
    client = LogtoClient(logto_config, storage=session_storage)
    base_url = get_base_url(request)
    post_logout_uri = os.getenv("LOGTO_POST_LOGOUT_URI", f"{base_url}/")
    sign_out_url = await client.signOut(postLogoutRedirectUri=post_logout_uri)
    return RedirectResponse(sign_out_url)


# ─── API ROUTES ─────────────────────────────────────────────────────────────

@app.get("/api/me")
async def me(user: User = Depends(get_current_user)):
    return {
        "username": user.logto_user_id,
        "display_name": user.display_name or user.email or "User",
        "email": user.email,
        "credits": user.credits,
        "role": user.role or "student",
        "is_vip": user.is_vip or False,
        "current_band": user.current_band or 0,
        "target_band": user.target_band or 0,
        "starting_band": user.starting_band or 0,
        "exam_date": user.exam_date.strftime("%Y-%m-%d") if user.exam_date else "",
        "created_at": str(user.created_at) if user.created_at else None,
    }


# ─── ROLE-BASED ACCESS ─────────────────────────────────────────────────────

async def require_admin(request: Request, db: Session = Depends(get_db)) -> User:
    user = await get_current_user(request, db)
    if user.role != 'admin':
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def log_audit(db: Session, admin: User, action: str, target_type: str = "", target_id: int = 0, details: str = ""):
    """Write an audit log entry."""
    try:
        entry = AuditLog(
            admin_id=admin.id,
            admin_email=admin.email or "",
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details[:1000] if details else "",
        )
        db.add(entry)
        db.commit()
    except Exception as e:
        logger.error(f"Failed to write audit log: {e}")

async def require_teacher_or_admin(request: Request, db: Session = Depends(get_db)) -> User:
    user = await get_current_user(request, db)
    if user.role not in ('admin', 'teacher'):
        raise HTTPException(status_code=403, detail="需要教师或管理员权限")
    return user


# ─── ADMIN API: USER MANAGEMENT ─────────────────────────────────────────────

@app.get("/api/admin/users")
async def admin_list_users(
    q: str = "",
    role: str = "",
    disabled: str = "",
    sort: str = "created_at",
    page: int = 1,
    limit: int = 50,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """List/search/filter users with pagination."""
    query = db.query(User)

    if q:
        like = f"%{q}%"
        query = query.filter(or_(User.email.like(like), User.display_name.like(like)))
    if role and role in ('admin', 'teacher', 'student'):
        query = query.filter(User.role == role)
    if disabled == 'true':
        query = query.filter(User.is_disabled == True)
    elif disabled == 'false':
        query = query.filter(User.is_disabled == False)

    total = query.count()

    if sort == "credits":
        query = query.order_by(User.credits.desc())
    elif sort == "last_active":
        query = query.order_by(User.last_active_at.desc())
    elif sort == "email":
        query = query.order_by(User.email.asc())
    else:
        query = query.order_by(User.created_at.desc())

    page = max(1, page)
    limit = min(max(1, limit), 200)
    users = query.offset((page - 1) * limit).limit(limit).all()

    return {
        "total": total,
        "page": page,
        "limit": limit,
        "users": [{
            "id": u.id,
            "email": u.email or "",
            "display_name": u.display_name or "",
            "role": u.role or "student",
            "credits": u.credits,
            "is_disabled": u.is_disabled or False,
            "is_vip": u.is_vip or False,
            "current_band": u.current_band or 0,
            "target_band": u.target_band or 0,
            "last_active_at": str(u.last_active_at) if u.last_active_at else "",
            "created_at": str(u.created_at) if u.created_at else "",
        } for u in users],
    }


class UpdateUserRequest(BaseModel):
    role: str = ""
    credits: int = -1
    display_name: str = ""
    is_vip: int = -1  # -1 = no change, 0 / 1


@app.post("/api/admin/users/{user_id}/update")
async def admin_update_user(user_id: int, body: UpdateUserRequest, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Update user role, credits, display name, or VIP status."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    changes = []
    if body.role and body.role in ('admin', 'teacher', 'student') and target.role != body.role:
        changes.append(f"role {target.role} -> {body.role}")
        target.role = body.role
    if body.credits >= 0 and target.credits != body.credits:
        changes.append(f"credits {target.credits} -> {body.credits}")
        target.credits = body.credits
    if body.display_name and target.display_name != body.display_name:
        changes.append(f"name {target.display_name} -> {body.display_name}")
        target.display_name = body.display_name
    if body.is_vip in (0, 1):
        new_vip = bool(body.is_vip)
        if (target.is_vip or False) != new_vip:
            changes.append(f"vip {target.is_vip or False} -> {new_vip}")
            target.is_vip = new_vip

    db.commit()
    if changes:
        log_audit(db, user, "update_user", "user", user_id, "; ".join(changes))
    return {"ok": True, "role": target.role, "credits": target.credits, "display_name": target.display_name, "is_vip": target.is_vip or False}


@app.post("/api/admin/users/{user_id}/disable")
async def admin_disable_user(user_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Disable a user account."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    if target.id == user.id:
        raise HTTPException(status_code=400, detail="不能禁用自己")
    target.is_disabled = True
    db.commit()
    log_audit(db, user, "disable_user", "user", user_id, f"disabled {target.email}")
    return {"ok": True}


@app.post("/api/admin/users/{user_id}/enable")
async def admin_enable_user(user_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Re-enable a disabled user."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    target.is_disabled = False
    db.commit()
    log_audit(db, user, "enable_user", "user", user_id, f"enabled {target.email}")
    return {"ok": True}


@app.get("/api/admin/users/{user_id}/details")
async def admin_user_details(user_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Get full user details including history."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    practice_count = db.query(Conversation).filter(Conversation.user_id == user_id).count()
    game_count = db.query(GameSession).filter(GameSession.user_id == user_id).count()

    recent_practice = db.query(Conversation).filter(
        Conversation.user_id == user_id
    ).order_by(Conversation.timestamp.desc()).limit(20).all()

    recent_games = db.query(GameSession).filter(
        GameSession.user_id == user_id
    ).order_by(GameSession.timestamp.desc()).limit(10).all()

    beijing_tz = timezone(timedelta(hours=8))
    fmt = lambda t: t.replace(tzinfo=timezone.utc).astimezone(beijing_tz).strftime("%Y-%m-%d %H:%M") if t else ""

    return {
        "user": {
            "id": target.id,
            "email": target.email or "",
            "display_name": target.display_name or "",
            "role": target.role or "student",
            "credits": target.credits,
            "is_disabled": target.is_disabled or False,
            "created_at": fmt(target.created_at),
            "last_active_at": fmt(target.last_active_at),
        },
        "stats": {
            "practice_count": practice_count,
            "game_count": game_count,
        },
        "recent_practice": [{
            "id": c.id,
            "created_at": fmt(c.timestamp),
            "question": c.question or "",
            "score": c.score or "",
            "topic_type": c.topic_type or "",
        } for c in recent_practice],
        "recent_games": [{
            "id": g.id,
            "created_at": fmt(g.timestamp),
            "mode": g.mode,
            "overall_score": g.overall_score,
            "rank": g.rank,
            "player_count": g.player_count,
        } for g in recent_games],
    }


class BulkCreditRequest(BaseModel):
    user_ids: list = []
    amount: int = 20
    mode: str = "set"  # "set" or "add"


@app.post("/api/admin/bulk-credit")
async def admin_bulk_credit(body: BulkCreditRequest, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Bulk credit top-up for multiple users."""
    if not body.user_ids:
        raise HTTPException(status_code=400, detail="请选择用户")
    if body.amount < 0:
        raise HTTPException(status_code=400, detail="积分数必须 >= 0")

    updated = 0
    for uid in body.user_ids:
        target = db.query(User).filter(User.id == uid).first()
        if target:
            if body.mode == "add":
                target.credits += body.amount
            else:
                target.credits = body.amount
            updated += 1
    db.commit()
    log_audit(db, user, "bulk_credit", "user", 0,
              f"{body.mode} {body.amount} to {updated} users: {body.user_ids[:20]}")
    return {"ok": True, "updated": updated}


# ─── ADMIN API: ANALYTICS ───────────────────────────────────────────────────

@app.get("/api/admin/analytics")
async def admin_analytics(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Dashboard analytics: stats, trends, top questions, etc."""
    now = datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=7)
    month_start = today_start - timedelta(days=30)

    # Basic counts
    total_users = db.query(User).count()
    total_teachers = db.query(User).filter(User.role == 'teacher').count()
    total_students = db.query(User).filter(User.role == 'student').count()
    total_admins = db.query(User).filter(User.role == 'admin').count()
    total_disabled = db.query(User).filter(User.is_disabled == True).count()
    total_conversations = db.query(Conversation).count()
    total_games = db.query(GameSession).count()

    # DAU / WAU / MAU (from conversations)
    dau = db.query(func.count(func.distinct(Conversation.user_id))).filter(
        Conversation.timestamp >= today_start
    ).scalar() or 0
    wau = db.query(func.count(func.distinct(Conversation.user_id))).filter(
        Conversation.timestamp >= week_start
    ).scalar() or 0
    mau = db.query(func.count(func.distinct(Conversation.user_id))).filter(
        Conversation.timestamp >= month_start
    ).scalar() or 0

    # Today's usage
    today_conversations = db.query(Conversation).filter(Conversation.timestamp >= today_start).count()
    today_games = db.query(GameSession).filter(GameSession.timestamp >= today_start).count()
    today_new_users = db.query(User).filter(User.created_at >= today_start).count()

    # Daily trend (last 14 days)
    trend = []
    for i in range(13, -1, -1):
        day_start = today_start - timedelta(days=i)
        day_end = day_start + timedelta(days=1)
        count_c = db.query(Conversation).filter(
            Conversation.timestamp >= day_start, Conversation.timestamp < day_end
        ).count()
        count_g = db.query(GameSession).filter(
            GameSession.timestamp >= day_start, GameSession.timestamp < day_end
        ).count()
        trend.append({
            "date": day_start.strftime("%m-%d"),
            "practice": count_c,
            "game": count_g,
        })

    # Top questions (last 30 days)
    top_questions_rows = db.query(
        Conversation.question, func.count(Conversation.id).label('cnt')
    ).filter(
        Conversation.timestamp >= month_start
    ).group_by(Conversation.question).order_by(func.count(Conversation.id).desc()).limit(10).all()
    top_questions = [{"question": row[0] or "(空)", "count": row[1]} for row in top_questions_rows]

    # Top teachers (by number of students)
    top_teachers_rows = db.query(
        TeacherStudent.teacher_id, func.count(TeacherStudent.student_id).label('cnt')
    ).group_by(TeacherStudent.teacher_id).order_by(func.count(TeacherStudent.student_id).desc()).limit(5).all()
    top_teachers = []
    for row in top_teachers_rows:
        t = db.query(User).filter(User.id == row[0]).first()
        if t:
            top_teachers.append({
                "id": t.id,
                "email": t.email,
                "display_name": t.display_name,
                "student_count": row[1],
            })

    # Cost estimation (rough: 1 conversation ≈ ¥0.016, 1 game ≈ ¥0.018)
    total_cost_estimate = round(total_conversations * 0.016 + total_games * 0.018, 2)
    month_conversations = db.query(Conversation).filter(Conversation.timestamp >= month_start).count()
    month_games = db.query(GameSession).filter(GameSession.timestamp >= month_start).count()
    month_cost_estimate = round(month_conversations * 0.016 + month_games * 0.018, 2)

    return {
        "summary": {
            "total_users": total_users,
            "total_teachers": total_teachers,
            "total_students": total_students,
            "total_admins": total_admins,
            "total_disabled": total_disabled,
            "total_conversations": total_conversations,
            "total_games": total_games,
            "dau": dau,
            "wau": wau,
            "mau": mau,
            "today_conversations": today_conversations,
            "today_games": today_games,
            "today_new_users": today_new_users,
            "total_cost_cny": total_cost_estimate,
            "month_cost_cny": month_cost_estimate,
        },
        "trend_14d": trend,
        "top_questions": top_questions,
        "top_teachers": top_teachers,
    }


# ─── ADMIN API: ANNOUNCEMENTS ───────────────────────────────────────────────

class AnnouncementRequest(BaseModel):
    title: str = ""
    content: str = ""
    target_role: str = "all"
    active: bool = True


@app.get("/api/admin/announcements")
async def admin_list_announcements(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    items = db.query(Announcement).order_by(Announcement.created_at.desc()).all()
    return [{
        "id": a.id,
        "title": a.title,
        "content": a.content,
        "target_role": a.target_role,
        "active": a.active,
        "created_at": str(a.created_at) if a.created_at else "",
    } for a in items]


@app.post("/api/admin/announcements")
async def admin_create_announcement(body: AnnouncementRequest, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    a = Announcement(
        title=body.title, content=body.content,
        target_role=body.target_role if body.target_role in ('all', 'student', 'teacher', 'admin') else 'all',
        active=body.active, created_by=user.id,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    log_audit(db, user, "create_announcement", "announcement", a.id, body.title)
    return {"ok": True, "id": a.id}


@app.post("/api/admin/announcements/{ann_id}/update")
async def admin_update_announcement(ann_id: int, body: AnnouncementRequest, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    a = db.query(Announcement).filter(Announcement.id == ann_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="公告不存在")
    a.title = body.title
    a.content = body.content
    a.target_role = body.target_role
    a.active = body.active
    db.commit()
    log_audit(db, user, "update_announcement", "announcement", ann_id, body.title)
    return {"ok": True}


@app.delete("/api/admin/announcements/{ann_id}")
async def admin_delete_announcement(ann_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    db.query(Announcement).filter(Announcement.id == ann_id).delete()
    db.commit()
    log_audit(db, user, "delete_announcement", "announcement", ann_id)
    return {"ok": True}


@app.get("/api/announcements/active")
async def get_active_announcements(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Public endpoint: get active announcements for current user's role."""
    my_role = user.role or "student"
    items = db.query(Announcement).filter(
        Announcement.active == True,
        or_(Announcement.target_role == "all", Announcement.target_role == my_role)
    ).order_by(Announcement.created_at.desc()).limit(5).all()
    return [{"id": a.id, "title": a.title, "content": a.content} for a in items]


# ─── ADMIN API: AUDIT LOGS ──────────────────────────────────────────────────

@app.get("/api/admin/audit-logs")
async def admin_list_audit_logs(limit: int = 100, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    limit = min(max(1, limit), 500)
    logs = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit).all()
    beijing_tz = timezone(timedelta(hours=8))
    return [{
        "id": l.id,
        "admin_email": l.admin_email or "",
        "action": l.action,
        "target_type": l.target_type,
        "target_id": l.target_id,
        "details": l.details or "",
        "created_at": l.created_at.replace(tzinfo=timezone.utc).astimezone(beijing_tz).strftime("%Y-%m-%d %H:%M:%S") if l.created_at else "",
    } for l in logs]


# ─── ADMIN API: EXPORT ──────────────────────────────────────────────────────

@app.get("/api/admin/export/users.csv")
async def admin_export_users(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Export all users as CSV."""
    users = db.query(User).order_by(User.created_at.desc()).all()
    lines = ["id,email,display_name,role,credits,is_disabled,created_at,last_active_at"]
    for u in users:
        lines.append(
            f'{u.id},"{u.email or ""}","{u.display_name or ""}",{u.role or ""},{u.credits},{u.is_disabled or False},{u.created_at or ""},{u.last_active_at or ""}'
        )
    csv_text = "\n".join(lines)
    log_audit(db, user, "export_users", "user", 0, f"exported {len(users)} users")
    from fastapi.responses import Response
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="users.csv"'},
    )


@app.get("/api/admin/export/user/{user_id}.json")
async def admin_export_user(user_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Export a single user's full data as JSON."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    convs = db.query(Conversation).filter(Conversation.user_id == user_id).all()
    games = db.query(GameSession).filter(GameSession.user_id == user_id).all()

    data = {
        "user": {
            "id": target.id, "email": target.email, "display_name": target.display_name,
            "role": target.role, "credits": target.credits,
            "created_at": str(target.created_at) if target.created_at else None,
        },
        "conversations": [{
            "id": c.id, "question": c.question, "user_input": c.user_input,
            "ai_reply": c.ai_reply, "topic_type": c.topic_type, "score": c.score,
            "timestamp": str(c.timestamp) if c.timestamp else None,
        } for c in convs],
        "game_sessions": [{
            "id": g.id, "mode": g.mode, "overall_score": g.overall_score,
            "rank": g.rank, "player_count": g.player_count,
            "answers": json.loads(g.answers_json) if g.answers_json else [],
            "verdict": json.loads(g.verdict_json) if g.verdict_json else {},
            "timestamp": str(g.timestamp) if g.timestamp else None,
        } for g in games],
    }
    log_audit(db, user, "export_user", "user", user_id)
    return JSONResponse(
        content=data,
        headers={"Content-Disposition": f'attachment; filename="user-{user_id}.json"'},
    )


# ─── ADMIN API: CLASSROOM MANAGEMENT ───────────────────────────────────────

class ClassRequest(BaseModel):
    name: str = ""
    teacher_id: int = 0
    description: str = ""


@app.get("/api/admin/classes")
async def admin_list_classes(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    classes = db.query(Classroom).order_by(Classroom.created_at.desc()).all()
    result = []
    for c in classes:
        teacher = db.query(User).filter(User.id == c.teacher_id).first()
        student_count = db.query(ClassStudent).filter(ClassStudent.class_id == c.id).count()
        result.append({
            "id": c.id,
            "name": c.name,
            "description": c.description or "",
            "teacher_id": c.teacher_id,
            "teacher_name": teacher.display_name if teacher else "",
            "teacher_email": teacher.email if teacher else "",
            "student_count": student_count,
            "created_at": str(c.created_at) if c.created_at else "",
        })
    return result


@app.post("/api/admin/classes")
async def admin_create_class(body: ClassRequest, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    if not body.name:
        raise HTTPException(status_code=400, detail="班级名不能为空")
    teacher = db.query(User).filter(User.id == body.teacher_id).first()
    if not teacher or teacher.role not in ('teacher', 'admin'):
        raise HTTPException(status_code=400, detail="指定的老师不存在或不是教师角色")
    c = Classroom(name=body.name, teacher_id=body.teacher_id, description=body.description)
    db.add(c)
    db.commit()
    db.refresh(c)
    log_audit(db, user, "create_class", "class", c.id, body.name)
    return {"ok": True, "id": c.id}


@app.delete("/api/admin/classes/{class_id}")
async def admin_delete_class(class_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    db.query(ClassStudent).filter(ClassStudent.class_id == class_id).delete()
    db.query(Classroom).filter(Classroom.id == class_id).delete()
    db.commit()
    log_audit(db, user, "delete_class", "class", class_id)
    return {"ok": True}


class ClassAddStudentRequest(BaseModel):
    student_emails: list = []


@app.post("/api/admin/classes/{class_id}/add-students")
async def admin_add_class_students(class_id: int, body: ClassAddStudentRequest, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    c = db.query(Classroom).filter(Classroom.id == class_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="班级不存在")
    added = 0
    not_found = []
    for email in body.student_emails:
        student = db.query(User).filter(User.email == email).first()
        if not student:
            not_found.append(email)
            continue
        existing = db.query(ClassStudent).filter(
            ClassStudent.class_id == class_id, ClassStudent.student_id == student.id
        ).first()
        if existing:
            continue
        # Also auto-add student to teacher's list
        teacher_link = db.query(TeacherStudent).filter(
            TeacherStudent.teacher_id == c.teacher_id, TeacherStudent.student_id == student.id
        ).first()
        if not teacher_link:
            db.add(TeacherStudent(teacher_id=c.teacher_id, student_id=student.id))
        db.add(ClassStudent(class_id=class_id, student_id=student.id))
        added += 1
    db.commit()
    log_audit(db, user, "add_class_students", "class", class_id, f"added {added}")
    return {"ok": True, "added": added, "not_found": not_found}


@app.get("/api/admin/classes/{class_id}/students")
async def admin_class_students(class_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    links = db.query(ClassStudent).filter(ClassStudent.class_id == class_id).all()
    ids = [l.student_id for l in links]
    if not ids:
        return []
    students = db.query(User).filter(User.id.in_(ids)).all()
    return [{
        "id": s.id, "email": s.email, "display_name": s.display_name,
        "credits": s.credits, "is_disabled": s.is_disabled or False,
    } for s in students]


@app.delete("/api/admin/classes/{class_id}/students/{student_id}")
async def admin_remove_class_student(class_id: int, student_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    db.query(ClassStudent).filter(
        ClassStudent.class_id == class_id, ClassStudent.student_id == student_id
    ).delete()
    db.commit()
    log_audit(db, user, "remove_class_student", "class", class_id, f"student {student_id}")
    return {"ok": True}


# ─── ADMIN API: CONTENT MANAGEMENT ─────────────────────────────────────────

class ContentRequest(BaseModel):
    key: str = ""
    kind: str = "sample"
    content: str = ""


@app.get("/api/admin/content")
async def admin_list_content(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    items = db.query(ContentItem).order_by(ContentItem.kind, ContentItem.key).all()
    return [{
        "id": i.id, "key": i.key, "kind": i.kind, "content": i.content,
        "updated_at": str(i.updated_at) if i.updated_at else "",
    } for i in items]


@app.post("/api/admin/content")
async def admin_upsert_content(body: ContentRequest, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    if not body.key:
        raise HTTPException(status_code=400, detail="key 不能为空")
    item = db.query(ContentItem).filter(ContentItem.key == body.key).first()
    if item:
        item.content = body.content
        item.kind = body.kind
        item.updated_at = datetime.utcnow()
        item.updated_by = user.id
    else:
        item = ContentItem(
            key=body.key, kind=body.kind, content=body.content, updated_by=user.id,
        )
        db.add(item)
    db.commit()
    log_audit(db, user, "upsert_content", "content", 0, body.key)
    return {"ok": True}


@app.delete("/api/admin/content/{content_id}")
async def admin_delete_content(content_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    db.query(ContentItem).filter(ContentItem.id == content_id).delete()
    db.commit()
    log_audit(db, user, "delete_content", "content", content_id)
    return {"ok": True}


# Legacy stats endpoint (kept for compatibility)
@app.get("/api/admin/stats")
async def admin_stats(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    total_users = db.query(User).count()
    total_conversations = db.query(Conversation).count()
    total_games = db.query(GameSession).count()
    role_counts = {}
    for role in ['admin', 'teacher', 'student']:
        role_counts[role] = db.query(User).filter(User.role == role).count()
    return {
        "total_users": total_users,
        "total_conversations": total_conversations,
        "total_games": total_games,
        "role_counts": role_counts,
    }


# ─── TEACHER API ────────────────────────────────────────────────────────────

@app.get("/api/teacher/students")
async def teacher_list_students(user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """List teacher's students."""
    links = db.query(TeacherStudent).filter(TeacherStudent.teacher_id == user.id).all()
    student_ids = [l.student_id for l in links]
    if not student_ids:
        return []
    students = db.query(User).filter(User.id.in_(student_ids)).all()
    return [{
        "id": s.id,
        "email": s.email or "",
        "display_name": s.display_name or "",
        "credits": s.credits,
        "created_at": str(s.created_at) if s.created_at else "",
    } for s in students]


class AddStudentRequest(BaseModel):
    email: str


@app.post("/api/teacher/add-student")
async def teacher_add_student(body: AddStudentRequest, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """Add a student by email (teacher only)."""
    student = db.query(User).filter(User.email == body.email).first()
    if not student:
        raise HTTPException(status_code=404, detail="未找到该邮箱对应的学生，请确认学生已注册")
    if student.id == user.id:
        raise HTTPException(status_code=400, detail="不能添加自己为学生")
    existing = db.query(TeacherStudent).filter(
        TeacherStudent.teacher_id == user.id, TeacherStudent.student_id == student.id
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="该学生已在你的列表中")
    link = TeacherStudent(teacher_id=user.id, student_id=student.id)
    db.add(link)
    db.commit()
    return {"ok": True, "student_id": student.id, "display_name": student.display_name, "email": student.email}


@app.delete("/api/teacher/remove-student/{student_id}")
async def teacher_remove_student(student_id: int, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """Remove a student from teacher's list."""
    db.query(TeacherStudent).filter(
        TeacherStudent.teacher_id == user.id, TeacherStudent.student_id == student_id
    ).delete()
    db.commit()
    return {"ok": True}


@app.get("/api/teacher/student/{student_id}/practice-history")
async def teacher_get_student_practice(student_id: int, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """Get a student's practice history (teacher only)."""
    # Verify teacher-student relationship
    link = db.query(TeacherStudent).filter(
        TeacherStudent.teacher_id == user.id, TeacherStudent.student_id == student_id
    ).first()
    if not link and user.role != 'admin':
        raise HTTPException(status_code=403, detail="该学生不在你的列表中")

    conversations = db.query(Conversation).filter(
        Conversation.user_id == student_id
    ).order_by(Conversation.timestamp.desc()).limit(100).all()

    beijing_tz = timezone(timedelta(hours=8))
    return [{
        "id": c.id,
        "created_at": c.timestamp.replace(tzinfo=timezone.utc).astimezone(beijing_tz).strftime("%Y-%m-%d %H:%M") if c.timestamp else "",
        "question": c.question or "",
        "user_input": c.user_input or "",
        "ai_reply": c.ai_reply or "",
        "topic_type": c.topic_type or "",
        "score": c.score or "",
    } for c in conversations]


@app.get("/api/teacher/student/{student_id}/game-history")
async def teacher_get_student_games(student_id: int, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """Get a student's game mock test history (teacher only)."""
    link = db.query(TeacherStudent).filter(
        TeacherStudent.teacher_id == user.id, TeacherStudent.student_id == student_id
    ).first()
    if not link and user.role != 'admin':
        raise HTTPException(status_code=403, detail="该学生不在你的列表中")

    sessions = db.query(GameSession).filter(
        GameSession.user_id == student_id
    ).order_by(GameSession.timestamp.desc()).limit(50).all()

    beijing_tz = timezone(timedelta(hours=8))
    return [{
        "id": s.id,
        "created_at": s.timestamp.replace(tzinfo=timezone.utc).astimezone(beijing_tz).strftime("%Y-%m-%d %H:%M") if s.timestamp else "",
        "mode": s.mode,
        "overall_score": s.overall_score,
        "rank": s.rank,
        "player_count": s.player_count,
        "answers": json.loads(s.answers_json) if s.answers_json else [],
        "verdict": json.loads(s.verdict_json) if s.verdict_json else {},
    } for s in sessions]


@app.post("/api/teacher/student/{student_id}/generate-report")
async def teacher_generate_report(student_id: int, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """AI-generate a learning report for a student based on their history."""
    link = db.query(TeacherStudent).filter(
        TeacherStudent.teacher_id == user.id, TeacherStudent.student_id == student_id
    ).first()
    if not link and user.role != 'admin':
        raise HTTPException(status_code=403, detail="该学生不在你的列表中")

    student = db.query(User).filter(User.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="学生不存在")

    # Gather practice history
    convos = db.query(Conversation).filter(
        Conversation.user_id == student_id
    ).order_by(Conversation.timestamp.desc()).limit(20).all()

    # Gather game history
    games = db.query(GameSession).filter(
        GameSession.user_id == student_id
    ).order_by(GameSession.timestamp.desc()).limit(10).all()

    # Build context
    practice_summary = "\n".join([
        f"- 题目: {c.question}, 分数: {c.score}, 类型: {c.topic_type}" for c in convos
    ]) or "暂无练习记录"

    game_summary = "\n".join([
        f"- 模考总分: {g.overall_score}, 模式: {g.mode}, 排名: {g.rank}/{g.player_count}" for g in games
    ]) or "暂无模考记录"

    # Get detailed game answers for analysis
    game_details = ""
    for g in games[:3]:  # Last 3 games
        answers = json.loads(g.answers_json) if g.answers_json else []
        verdict = json.loads(g.verdict_json) if g.verdict_json else {}
        game_details += f"\n模考 (总分{g.overall_score}):\n"
        for a in answers:
            game_details += f"  Q: {a.get('question','')}\n  A: {a.get('answer','')}\n  Scores: {a.get('scores','')}\n"
        if verdict:
            game_details += f"  Verdict: {verdict.get('comment','')}\n"

    prompt = f"""你是一位资深雅思口语教师，请根据以下学生的练习和模考数据，生成一份详细的学习报告和改进计划。

学生: {student.display_name or student.email}

## 练习记录（最近20次）
{practice_summary}

## 模考记录（最近10次）
{game_summary}

## 模考详细答案（最近3次）
{game_details}

请生成：
1. **总体评估**：学生目前的口语水平（预估band分数），强项和弱项
2. **问题分析**：具体的语法、词汇、流利度问题，引用学生的实际答案举例
3. **学习计划**：接下来 2 周的具体学习建议，包含每天的练习目标
4. **推荐练习**：针对弱项推荐的具体话题和练习方式
5. **鼓励寄语**：给学生的正面鼓励

请用中文回复，格式清晰，使用 markdown。"""

    try:
        report = await call_deepseek([
            {'role': 'system', 'content': '你是一位资深雅思口语教师，擅长根据学生数据制定个性化学习计划。'},
            {'role': 'user', 'content': prompt},
        ], max_tokens=3000, temperature=0.7)

        # Auto-save the generated report
        saved = LearningReport(
            student_id=student_id,
            teacher_id=user.id,
            title=f"学习报告 {datetime.utcnow().strftime('%Y-%m-%d')}",
            content=report,
            band_at_time=student.current_band or 0,
        )
        db.add(saved)
        db.commit()
        db.refresh(saved)

        return {"ok": True, "report": report, "report_id": saved.id}
    except Exception as e:
        logger.error(f"Failed to generate report: {e}")
        raise HTTPException(status_code=500, detail="生成报告失败，请稍后重试")


# ─── LEARNING REPORTS / TIMELINE / MILESTONES / STUDY PLANS ──────────────────

def _can_view_student(teacher: User, student_id: int, db: Session) -> bool:
    """Check if teacher (or admin) can access this student."""
    if teacher.role == 'admin':
        return True
    link = db.query(TeacherStudent).filter(
        TeacherStudent.teacher_id == teacher.id,
        TeacherStudent.student_id == student_id,
    ).first()
    return link is not None


@app.get("/api/teacher/student/{student_id}/reports")
async def list_student_reports(student_id: int, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    if not _can_view_student(user, student_id, db):
        raise HTTPException(status_code=403, detail="无权访问该学生")
    reports = db.query(LearningReport).filter(
        LearningReport.student_id == student_id
    ).order_by(LearningReport.created_at.desc()).all()
    beijing_tz = timezone(timedelta(hours=8))
    return [{
        "id": r.id,
        "title": r.title,
        "content": r.content,
        "band_at_time": r.band_at_time,
        "created_at": r.created_at.replace(tzinfo=timezone.utc).astimezone(beijing_tz).strftime("%Y-%m-%d %H:%M") if r.created_at else "",
    } for r in reports]


@app.delete("/api/teacher/reports/{report_id}")
async def delete_report(report_id: int, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    r = db.query(LearningReport).filter(LearningReport.id == report_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="报告不存在")
    if user.role != 'admin' and r.teacher_id != user.id:
        raise HTTPException(status_code=403, detail="无权删除该报告")
    db.delete(r)
    db.commit()
    return {"ok": True}


class UpdateReportRequest(BaseModel):
    title: str = ""
    content: str = ""


@app.post("/api/teacher/reports/{report_id}/update")
async def update_report(report_id: int, body: UpdateReportRequest, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    r = db.query(LearningReport).filter(LearningReport.id == report_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="报告不存在")
    if user.role != 'admin' and r.teacher_id != user.id:
        raise HTTPException(status_code=403, detail="无权编辑该报告")
    if body.title:
        r.title = body.title
    if body.content:
        r.content = body.content
    db.commit()
    return {"ok": True}


class StudentProfileRequest(BaseModel):
    starting_band: float = -1
    current_band: float = -1
    target_band: float = -1
    exam_date: str = ""  # YYYY-MM-DD
    is_vip: int = -1  # -1 = no change, 0 / 1


@app.post("/api/teacher/student/{student_id}/profile")
async def update_student_profile(student_id: int, body: StudentProfileRequest, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """Update a student's learning profile (band, target, exam date)."""
    if not _can_view_student(user, student_id, db):
        raise HTTPException(status_code=403, detail="无权访问该学生")
    student = db.query(User).filter(User.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="学生不存在")

    old_band = student.current_band or 0

    if body.starting_band >= 0:
        student.starting_band = body.starting_band
        if not student.current_band:
            student.current_band = body.starting_band
    if body.current_band >= 0:
        student.current_band = body.current_band
    if body.target_band >= 0:
        student.target_band = body.target_band
    if body.exam_date:
        try:
            student.exam_date = datetime.strptime(body.exam_date, "%Y-%m-%d")
        except ValueError:
            pass
    if body.is_vip in (0, 1):
        # Only admin can change VIP
        if user.role == 'admin':
            student.is_vip = bool(body.is_vip)
    db.commit()

    # Auto-create milestone if band advanced by >=0.5
    new_band = student.current_band or 0
    if new_band > old_band and new_band - old_band >= 0.5:
        # Create milestone for each 0.5 step
        steps = int(round((new_band - old_band) / 0.5))
        for i in range(steps):
            from_b = old_band + i * 0.5
            to_b = old_band + (i + 1) * 0.5
            ms = Milestone(
                student_id=student_id,
                from_band=from_b,
                to_band=to_b,
                notes=f"老师 {user.display_name or user.email} 评估通过 Band {to_b}",
                created_by=user.id,
            )
            db.add(ms)
        db.commit()

    return {"ok": True}


@app.get("/api/teacher/student/{student_id}/timeline")
async def student_timeline(student_id: int, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """Combined timeline: profile, milestones, reports, study plans, recent practice/games."""
    if not _can_view_student(user, student_id, db):
        raise HTTPException(status_code=403, detail="无权访问该学生")
    student = db.query(User).filter(User.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="学生不存在")

    beijing_tz = timezone(timedelta(hours=8))
    fmt = lambda t: t.replace(tzinfo=timezone.utc).astimezone(beijing_tz).strftime("%Y-%m-%d %H:%M") if t else ""
    fmt_d = lambda t: t.strftime("%Y-%m-%d") if t else ""

    milestones = db.query(Milestone).filter(Milestone.student_id == student_id).order_by(Milestone.achieved_at.desc()).all()
    reports = db.query(LearningReport).filter(LearningReport.student_id == student_id).order_by(LearningReport.created_at.desc()).all()
    plans = db.query(StudyPlan).filter(StudyPlan.student_id == student_id).order_by(StudyPlan.created_at.desc()).all()

    # Recent activity
    recent_practice = db.query(Conversation).filter(Conversation.user_id == student_id).order_by(Conversation.timestamp.desc()).limit(5).all()
    recent_games = db.query(GameSession).filter(GameSession.user_id == student_id).order_by(GameSession.timestamp.desc()).limit(5).all()

    # Build unified events list
    events = []
    for ms in milestones:
        events.append({
            "type": "milestone",
            "timestamp": fmt(ms.achieved_at),
            "title": f"🏆 Band {ms.from_band} → {ms.to_band}",
            "description": ms.notes or "",
            "data": {"id": ms.id, "from_band": ms.from_band, "to_band": ms.to_band},
        })
    for r in reports:
        events.append({
            "type": "report",
            "timestamp": fmt(r.created_at),
            "title": f"📋 {r.title}",
            "description": (r.content or "")[:100],
            "data": {"id": r.id, "band_at_time": r.band_at_time},
        })
    for p in plans:
        events.append({
            "type": "plan",
            "timestamp": fmt(p.created_at),
            "title": f"📅 {p.title}",
            "description": f"目标 Band {p.target_band}" + (f" · 考试 {fmt_d(p.exam_date)}" if p.exam_date else ""),
            "data": {"id": p.id, "target_band": p.target_band, "status": p.status},
        })
    for c in recent_practice:
        events.append({
            "type": "practice",
            "timestamp": fmt(c.timestamp),
            "title": f"✏️ {(c.question or '')[:60]}",
            "description": c.score or "",
            "data": {"id": c.id},
        })
    for g in recent_games:
        events.append({
            "type": "game",
            "timestamp": fmt(g.timestamp),
            "title": f"⚖️ 模考 {g.mode} · {g.overall_score or '--'}",
            "description": "",
            "data": {"id": g.id, "overall_score": g.overall_score},
        })

    events.sort(key=lambda e: e["timestamp"], reverse=True)

    return {
        "student": {
            "id": student.id,
            "email": student.email,
            "display_name": student.display_name,
            "is_vip": student.is_vip or False,
            "starting_band": student.starting_band or 0,
            "current_band": student.current_band or 0,
            "target_band": student.target_band or 0,
            "exam_date": fmt_d(student.exam_date),
            "credits": student.credits,
        },
        "events": events,
        "milestones": [{
            "id": m.id, "from_band": m.from_band, "to_band": m.to_band,
            "notes": m.notes, "achieved_at": fmt(m.achieved_at),
        } for m in milestones],
        "reports": [{
            "id": r.id, "title": r.title, "band_at_time": r.band_at_time,
            "created_at": fmt(r.created_at),
        } for r in reports],
        "plans": [{
            "id": p.id, "title": p.title, "target_band": p.target_band,
            "exam_date": fmt_d(p.exam_date), "status": p.status,
            "content": p.content,
            "created_at": fmt(p.created_at),
        } for p in plans],
    }


class GeneratePlanRequest(BaseModel):
    target_band: float = 6.5
    exam_date: str = ""  # YYYY-MM-DD


@app.post("/api/teacher/student/{student_id}/generate-plan")
async def generate_study_plan(student_id: int, body: GeneratePlanRequest, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """Generate AI study plan for a VIP student. Saves to DB."""
    if not _can_view_student(user, student_id, db):
        raise HTTPException(status_code=403, detail="无权访问该学生")
    student = db.query(User).filter(User.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="学生不存在")

    # VIP gating: only VIP students get this feature (or admin override)
    if not student.is_vip and user.role != 'admin':
        raise HTTPException(status_code=403, detail="该功能仅 VIP 学员可用")

    exam_dt = None
    days_until_exam = ""
    if body.exam_date:
        try:
            exam_dt = datetime.strptime(body.exam_date, "%Y-%m-%d")
            delta = (exam_dt - datetime.utcnow()).days
            days_until_exam = f"距离考试还有 {delta} 天"
        except ValueError:
            pass

    # Gather student data
    convs = db.query(Conversation).filter(Conversation.user_id == student_id).order_by(Conversation.timestamp.desc()).limit(15).all()
    games = db.query(GameSession).filter(GameSession.user_id == student_id).order_by(GameSession.timestamp.desc()).limit(5).all()
    milestones = db.query(Milestone).filter(Milestone.student_id == student_id).all()

    practice_sum = "\n".join([f"- {c.question} ({c.score})" for c in convs]) or "暂无练习记录"
    game_sum = "\n".join([f"- 总分 {g.overall_score}, 模式 {g.mode}" for g in games]) or "暂无模考记录"
    ms_sum = "\n".join([f"- Band {m.from_band} → {m.to_band}" for m in milestones]) or "暂无里程碑"

    current_band = student.current_band or 0
    starting_band = student.starting_band or 0

    prompt = f"""你是一位资深雅思口语和写作教师，请为学生制定个性化的详细学习计划。

学生信息：
- 姓名: {student.display_name or student.email}
- 入学时分数: {starting_band}
- 当前分数: {current_band}
- 目标分数: {body.target_band}
- {days_until_exam if days_until_exam else '考试日期未定'}
- VIP 学员

最近练习：
{practice_sum}

最近模考：
{game_sum}

历史里程碑：
{ms_sum}

请生成一份完整的学习计划，包含：

1. **学情分析**：当前水平评估、主要短板、需要重点突破的能力
2. **阶段目标分解**：把从 {current_band} 到 {body.target_band} 分为几个小阶段，每个阶段的能力目标
3. **每周学习安排**（具体到每天）：
   - 周一/周二/周三/周四/周五/周六/周日 各学什么
   - 每天大约学多长时间
   - 用什么资源/方法
4. **练习量建议**：每天/每周应该完成多少次本平台的口语练习和模考
5. **提升关键点**：针对学生具体的弱项，给出 3-5 个可执行的改进策略
6. **考试冲刺策略**（如果有考试日期）：考前 2 周的冲刺安排
7. **预期成果**：按计划执行的话，多久能达到目标分数

请用中文，markdown 格式，详细具体，不要泛泛而谈。"""

    try:
        plan_content = await call_deepseek([
            {'role': 'system', 'content': '你是一位资深雅思教师，擅长制定个性化学习计划。'},
            {'role': 'user', 'content': prompt},
        ], max_tokens=3500, temperature=0.7)

        # Save plan
        plan = StudyPlan(
            student_id=student_id,
            teacher_id=user.id,
            title=f"学习计划 {datetime.utcnow().strftime('%Y-%m-%d')} (目标 Band {body.target_band})",
            target_band=body.target_band,
            exam_date=exam_dt,
            content=plan_content,
            status="active",
        )
        db.add(plan)
        db.commit()
        db.refresh(plan)

        return {"ok": True, "plan_id": plan.id, "content": plan_content}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to generate plan: {e}")
        raise HTTPException(status_code=500, detail="生成学习计划失败")


class WritePlanRequest(BaseModel):
    title: str = ""
    target_band: float = 0
    exam_date: str = ""
    content: str = ""


@app.post("/api/teacher/student/{student_id}/write-plan")
async def write_plan(student_id: int, body: WritePlanRequest, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """Save a plan that the teacher wrote manually."""
    if not _can_view_student(user, student_id, db):
        raise HTTPException(status_code=403, detail="无权访问该学生")
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="计划内容不能为空")
    student = db.query(User).filter(User.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="学生不存在")

    exam_dt = None
    if body.exam_date:
        try:
            exam_dt = datetime.strptime(body.exam_date, "%Y-%m-%d")
        except ValueError:
            pass

    plan = StudyPlan(
        student_id=student_id,
        teacher_id=user.id,
        title=body.title or f"学习计划 {datetime.utcnow().strftime('%Y-%m-%d')}",
        target_band=body.target_band,
        exam_date=exam_dt,
        content=body.content,
        status="active",
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return {"ok": True, "plan_id": plan.id}


class OptimizePlanRequest(BaseModel):
    content: str = ""


@app.post("/api/teacher/optimize-plan")
async def optimize_plan(body: OptimizePlanRequest, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    """AI optimize a plan's wording — does NOT add new content, just makes it clearer/more rigorous."""
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="内容不能为空")

    prompt = f"""你是一位资深的教学专家。下面是一份老师写的学生学习计划，请对它进行优化。

【重要原则】：
- 不要添加任何老师没有提到的新内容（如新的练习项、新的资源、新的目标等）
- 不要扩展或发挥老师的原意
- 不要改变计划的整体结构和顺序
- 只在原有内容的基础上：
  1. 让表达更严谨、清晰、专业
  2. 修正语法错误和不通顺的地方
  3. 适当使用 markdown 格式（标题、列表、加粗）让结构更清晰
  4. 把模糊的表达说得更具体（但只针对老师已经写到的内容）
- 保持老师原有的语气和教学风格

老师写的原始计划：
---
{body.content}
---

请直接输出优化后的计划，不要加任何前言、解释或后记。"""

    try:
        optimized = await call_deepseek([
            {'role': 'system', 'content': '你是一位资深的教学文档编辑专家，专门帮老师优化学习计划的措辞，但绝不添加新内容。'},
            {'role': 'user', 'content': prompt},
        ], max_tokens=3500, temperature=0.3)
        return {"ok": True, "optimized": optimized}
    except Exception as e:
        logger.error(f"Failed to optimize plan: {e}")
        raise HTTPException(status_code=500, detail="优化失败，请稍后重试")


@app.delete("/api/teacher/plans/{plan_id}")
async def delete_plan(plan_id: int, user: User = Depends(require_teacher_or_admin), db: Session = Depends(get_db)):
    p = db.query(StudyPlan).filter(StudyPlan.id == plan_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="计划不存在")
    if user.role != 'admin' and p.teacher_id != user.id:
        raise HTTPException(status_code=403, detail="无权删除该计划")
    db.delete(p)
    db.commit()
    return {"ok": True}


# ─── STUDENT VIEW: own timeline ─────────────────────────────────────────────

@app.get("/api/me/timeline")
async def my_timeline(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Student's own learning timeline (limited info)."""
    beijing_tz = timezone(timedelta(hours=8))
    fmt = lambda t: t.replace(tzinfo=timezone.utc).astimezone(beijing_tz).strftime("%Y-%m-%d %H:%M") if t else ""
    fmt_d = lambda t: t.strftime("%Y-%m-%d") if t else ""

    milestones = db.query(Milestone).filter(Milestone.student_id == user.id).order_by(Milestone.achieved_at.desc()).all()
    reports = db.query(LearningReport).filter(LearningReport.student_id == user.id).order_by(LearningReport.created_at.desc()).all()
    plans = db.query(StudyPlan).filter(StudyPlan.student_id == user.id).order_by(StudyPlan.created_at.desc()).all()

    return {
        "profile": {
            "is_vip": user.is_vip or False,
            "starting_band": user.starting_band or 0,
            "current_band": user.current_band or 0,
            "target_band": user.target_band or 0,
            "exam_date": fmt_d(user.exam_date),
        },
        "milestones": [{
            "id": m.id, "from_band": m.from_band, "to_band": m.to_band,
            "notes": m.notes, "achieved_at": fmt(m.achieved_at),
        } for m in milestones],
        "reports": [{
            "id": r.id, "title": r.title, "content": r.content,
            "band_at_time": r.band_at_time, "created_at": fmt(r.created_at),
        } for r in reports],
        "plans": [{
            "id": p.id, "title": p.title, "target_band": p.target_band,
            "exam_date": fmt_d(p.exam_date), "status": p.status,
            "content": p.content, "created_at": fmt(p.created_at),
        } for p in plans],
    }


class UpgradeRequest(BaseModel):
    messages: list
    max_tokens: int = 1800
    temperature: float = 0.3
    stream: bool = True


@app.post("/api/upgrade")
async def upgrade(request: Request, body: UpgradeRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Proxy to DeepSeek. Credit is checked here but deducted in save-conversation."""
    api_key = get_deepseek_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="DEEPSEEK_API_KEY not configured")

    # Per-user rate limit (50/min/user, supports ~10 full practice sessions per minute)
    # Using logto_user_id so users on shared WiFi don't interfere with each other
    if not rate_limiter.is_allowed(f"user:{user.logto_user_id}", limit_per_minute=50):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍等片刻再试")

    # Credit check only (not deducted here; deducted in save-conversation to avoid over-charging on parallel requests)
    if user.credits <= 0:
        raise HTTPException(status_code=402, detail="积分已用完，请联系管理员充值")

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
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            ) as resp:
                async for chunk in resp.aiter_bytes():
                    yield chunk

    return StreamingResponse(stream_gen(), media_type="text/event-stream")


class SaveConversationRequest(BaseModel):
    question: str
    user_input: str
    ai_reply: str
    topic_type: str = ""
    score: str = ""


@app.post("/api/save-conversation")
async def save_conversation(body: SaveConversationRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Save a completed conversation to database and deduct 1 credit."""
    # Deduct 1 credit per successful practice session
    fresh_user = db.query(User).filter(User.id == user.id).first()
    if fresh_user and fresh_user.credits > 0:
        fresh_user.credits -= 1
        db.commit()

    conv = Conversation(
        user_id=user.id,
        question=body.question,
        user_input=body.user_input,
        ai_reply=body.ai_reply,
        topic_type=body.topic_type,
        score=body.score,
    )
    db.add(conv)
    db.commit()

    return {"ok": True, "credits": fresh_user.credits if fresh_user else 0}


@app.get("/api/history")
async def get_history(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get user's conversation history."""
    conversations = db.query(Conversation).filter(
        Conversation.user_id == user.id
    ).order_by(Conversation.timestamp.desc()).limit(50).all()

    beijing_tz = timezone(timedelta(hours=8))
    history = []
    for conv in conversations:
        ts = conv.timestamp
        if ts:
            utc_time = ts.replace(tzinfo=timezone.utc)
            beijing_time = utc_time.astimezone(beijing_tz)
            formatted_time = beijing_time.strftime("%Y-%m-%d %H:%M")
        else:
            formatted_time = ""

        history.append({
            "id": conv.id,
            "created_at": formatted_time,
            "question": conv.question or "",
            "user_input": conv.user_input or "",
            "ai_reply": conv.ai_reply or "",
            "topic_type": conv.topic_type or "",
            "score": conv.score or "",
        })

    return history


class SaveGameSessionRequest(BaseModel):
    mode: str = "solo"
    answers: list = []
    verdict: dict = {}


@app.post("/api/save-game-session")
async def save_game_session(body: SaveGameSessionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Save a game mock test session to database."""
    overall = body.verdict.get('overall', '')
    game_session = GameSession(
        user_id=user.id,
        logto_user_id=user.logto_user_id,
        room_code='',
        mode=body.mode,
        answers_json=json.dumps(body.answers, ensure_ascii=False),
        verdict_json=json.dumps(body.verdict, ensure_ascii=False),
        overall_score=str(overall),
        rank=1,
        player_count=1,
    )
    db.add(game_session)
    db.commit()
    return {"ok": True}


@app.get("/api/game-history")
async def get_game_history(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get user's game mock test history."""
    sessions = db.query(GameSession).filter(
        GameSession.user_id == user.id
    ).order_by(GameSession.timestamp.desc()).limit(50).all()

    beijing_tz = timezone(timedelta(hours=8))
    result = []
    for s in sessions:
        ts = s.timestamp
        if ts:
            utc_time = ts.replace(tzinfo=timezone.utc)
            formatted_time = utc_time.astimezone(beijing_tz).strftime("%Y-%m-%d %H:%M")
        else:
            formatted_time = ""

        result.append({
            "id": s.id,
            "created_at": formatted_time,
            "mode": s.mode,
            "overall_score": s.overall_score,
            "rank": s.rank,
            "player_count": s.player_count,
            "answers": json.loads(s.answers_json) if s.answers_json else [],
            "verdict": json.loads(s.verdict_json) if s.verdict_json else {},
        })

    return result


# ─── MULTIPLAYER ENDPOINTS ──────────────────────────────────────────────────

@app.post("/api/room/create")
async def create_room(user: User = Depends(get_current_user)):
    code = generate_room_code()
    room = Room(code=code, host=user.logto_user_id)
    rooms[code] = room
    return {"code": code}


@app.get("/api/room/{code}")
async def get_room(code: str):
    room = rooms.get(code.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return room_state_msg(room)


@app.websocket("/ws/game/{room_code}")
async def ws_game(websocket: WebSocket, room_code: str):
    """WebSocket for multiplayer game, authenticated via Logto session."""
    # Auth via Logto session
    user_info = ws_get_user_from_logto()
    if not user_info:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    room_code = room_code.upper()
    room = rooms.get(room_code)
    if not room:
        await websocket.close(code=4004, reason="Room not found")
        return

    username = user_info["username"]
    display_name = user_info["display_name"]

    if room.status != 'lobby' and username not in room.players:
        await websocket.close(code=4003, reason="Game already in progress")
        return

    await websocket.accept()

    if username in room.players:
        room.players[username].ws = websocket
        room.players[username].connected = True
    else:
        room.players[username] = Player(
            username=username, display_name=display_name, ws=websocket,
        )

    await broadcast(room, room_state_msg(room))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            msg_type = msg.get('type', '')

            if msg_type == 'start_game':
                if username == room.host and room.status == 'lobby' and len(room.players) >= 1:
                    room.game_task = asyncio.create_task(run_game_loop(room))

            elif msg_type == 'submit_answer':
                answer = msg.get('answer', '(No answer provided)')
                player = room.players.get(username)
                if player:
                    player.answers.append({
                        'part': room.current_part,
                        'question': room.current_question,
                        'answer': answer,
                    })
                    room.answers_received.add(username)
                    connected_count = sum(1 for p in room.players.values() if p.connected)
                    await broadcast(room, {
                        'type': 'player_submitted',
                        'username': username,
                        'count': len(room.answers_received),
                        'total': connected_count,
                    })

            elif msg_type == 'ready':
                room.ready_received.add(username)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        player = room.players.get(username)
        if player:
            player.connected = False
        await broadcast(room, {'type': 'player_left', 'username': username}, exclude=username)
        await broadcast(room, room_state_msg(room), exclude=username)

        if all(not p.connected for p in room.players.values()):
            if room.game_task:
                room.game_task.cancel()
            rooms.pop(room_code, None)


# ─── HEALTH CHECK ───────────────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    return {"status": "healthy", "database": "connected", "logto": "configured" if logto_config else "not configured"}


# ─── STATIC / FRONTEND ─────────────────────────────────────────────────────

static_dir = Path("./static")
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

@app.get("/favicon.ico")
async def favicon():
    # Return empty 204 to avoid 404 logs
    from fastapi.responses import Response
    return Response(status_code=204)

@app.get("/")
async def index():
    html = static_dir / "index.html"
    if not html.exists():
        raise HTTPException(status_code=404, detail="Frontend not found")
    return FileResponse(str(html))

@app.get("/guide")
async def guide():
    html = static_dir / "guide.html"
    if not html.exists():
        raise HTTPException(status_code=404, detail="Guide page not found")
    return FileResponse(str(html))

@app.get("/game")
async def game():
    html = static_dir / "game.html"
    if not html.exists():
        raise HTTPException(status_code=404, detail="Game page not found")
    return FileResponse(str(html))

@app.get("/admin")
async def admin_page():
    html = static_dir / "admin.html"
    if not html.exists():
        raise HTTPException(status_code=404, detail="Admin page not found")
    return FileResponse(str(html))

@app.get("/teacher")
async def teacher_page():
    html = static_dir / "teacher.html"
    if not html.exists():
        raise HTTPException(status_code=404, detail="Teacher page not found")
    return FileResponse(str(html))


# ─── ENTRYPOINT ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
