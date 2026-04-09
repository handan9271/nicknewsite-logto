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
from sqlalchemy import Column, Integer, String, Text, DateTime, create_engine
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

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE = "https://api.deepseek.com/v1/chat/completions"

LOGTO_ENDPOINT = os.getenv("LOGTO_ENDPOINT", "")
LOGTO_APP_ID = os.getenv("LOGTO_APP_ID", "")
LOGTO_APP_SECRET = os.getenv("LOGTO_APP_SECRET", "")
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")

# ─── RATE LIMITER ───────────────────────────────────────────────────────────

class SimpleRateLimiter:
    def __init__(self):
        self.requests = defaultdict(list)

    def is_allowed(self, ip: str, limit_per_minute: int = 10) -> bool:
        now = time_now()
        minute_ago = now - 60
        self.requests[ip] = [t for t in self.requests[ip] if t > minute_ago]
        if len(self.requests[ip]) >= limit_per_minute:
            return False
        self.requests[ip].append(now)
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
    name = getattr(user_info, 'name', None) or email.split("@")[0] if email else "User"

    db_user = db.query(User).filter(User.logto_user_id == logto_user_id).first()
    if not db_user:
        db_user = User(logto_user_id=logto_user_id, email=email, display_name=name)
        db.add(db_user)
        db.commit()
        db.refresh(db_user)
        logger.info(f"New user created: {email}")

    # Update display_name if changed
    if name and db_user.display_name != name:
        db_user.display_name = name
        db.commit()

    return db_user


# ─── DEEPSEEK SHARED HELPER ────────────────────────────────────────────────

async def call_deepseek(messages: list, max_tokens: int = 1800, temperature: float = 0.5) -> str:
    """Call DeepSeek API and return the full text response."""
    if not DEEPSEEK_API_KEY:
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
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
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
        "created_at": str(user.created_at) if user.created_at else None,
    }


# ─── ROLE-BASED ACCESS ─────────────────────────────────────────────────────

async def require_admin(request: Request, db: Session = Depends(get_db)) -> User:
    user = await get_current_user(request, db)
    if user.role != 'admin':
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user

async def require_teacher_or_admin(request: Request, db: Session = Depends(get_db)) -> User:
    user = await get_current_user(request, db)
    if user.role not in ('admin', 'teacher'):
        raise HTTPException(status_code=403, detail="需要教师或管理员权限")
    return user


# ─── ADMIN API ──────────────────────────────────────────────────────────────

@app.get("/api/admin/users")
async def admin_list_users(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """List all users (admin only)."""
    users = db.query(User).order_by(User.created_at.desc()).all()
    return [{
        "id": u.id,
        "email": u.email or "",
        "display_name": u.display_name or "",
        "role": u.role or "student",
        "credits": u.credits,
        "created_at": str(u.created_at) if u.created_at else "",
    } for u in users]


class UpdateUserRequest(BaseModel):
    role: str = ""
    credits: int = -1  # -1 means don't change


@app.post("/api/admin/users/{user_id}/update")
async def admin_update_user(user_id: int, body: UpdateUserRequest, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Update user role or credits (admin only)."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    if body.role and body.role in ('admin', 'teacher', 'student'):
        target.role = body.role
    if body.credits >= 0:
        target.credits = body.credits
    db.commit()
    return {"ok": True, "role": target.role, "credits": target.credits}


@app.get("/api/admin/stats")
async def admin_stats(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Dashboard statistics (admin only)."""
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
        return {"ok": True, "report": report}
    except Exception as e:
        logger.error(f"Failed to generate report: {e}")
        raise HTTPException(status_code=500, detail="生成报告失败，请稍后重试")


class UpgradeRequest(BaseModel):
    messages: list
    max_tokens: int = 1800
    temperature: float = 0.3
    stream: bool = True


@app.post("/api/upgrade")
async def upgrade(request: Request, body: UpgradeRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Proxy to DeepSeek with credit check, forwarding stream back to client."""
    if not DEEPSEEK_API_KEY:
        raise HTTPException(status_code=500, detail="DEEPSEEK_API_KEY not configured")

    # Rate limit
    client_ip = get_client_ip(request)
    if not rate_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")

    # Credit check
    if user.credits <= 0:
        raise HTTPException(status_code=402, detail="积分已用完，请联系管理员充值")

    # Deduct credit
    locked_user = db.query(User).filter(User.id == user.id).first()
    if locked_user and locked_user.credits > 0:
        locked_user.credits -= 1
        db.commit()

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


class SaveConversationRequest(BaseModel):
    question: str
    user_input: str
    ai_reply: str
    topic_type: str = ""
    score: str = ""


@app.post("/api/save-conversation")
async def save_conversation(body: SaveConversationRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Save a completed conversation to database."""
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

    # Return current credits
    fresh_user = db.query(User).filter(User.id == user.id).first()
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
