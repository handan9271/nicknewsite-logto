"""
Nick Speaking Platform — Backend
- POST /api/login       账号密码登录，返回 session token
- POST /api/upgrade     DeepSeek 代理（需要有效 token），流式转发
- GET  /api/me          验证 token
- POST /api/logout      退出
- POST /api/room/create 创建多人房间
- GET  /api/room/{code} 查询房间状态
- WS   /ws/game/{code}  多人游戏 WebSocket
- GET  /                返回前端 HTML
"""

import os, json, secrets, hashlib, time, asyncio, string, random
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field

from fastapi import FastAPI, Request, HTTPException, Depends, WebSocket, WebSocketDisconnect, Query
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

# ─── MULTIPLAYER: DATA STRUCTURES ─────────────────────────────────────────────

@dataclass
class Player:
    username: str
    display_name: str
    ws: WebSocket
    answers: list = field(default_factory=list)      # [{part, question, answer, scores}]
    final_verdict: dict | None = None
    connected: bool = True

@dataclass
class Room:
    code: str
    host: str
    players: dict = field(default_factory=dict)  # username -> Player
    status: str = 'lobby'   # lobby | playing | scoring | done
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

# ─── DEEPSEEK SHARED HELPER ─────────────────────────────────────────────────

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
    import re
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
    """Score an answer using DeepSeek, with offline fallback."""
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
    # Offline fallback
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
    """Compute final verdict for a player."""
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
    # Offline fallback
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

# ─── MULTIPLAYER GAME LOOP ──────────────────────────────────────────────────

async def run_game_loop(room: Room):
    """Server-authoritative game loop that drives the entire multiplayer match."""
    try:
        # Shuffle questions
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

        # Broadcast game_start
        await broadcast(room, {
            'type': 'game_start',
            'questions_part1': room.questions_part1,
            'part2_topic': room.part2_topic,
        })

        # Intro phase — wait for all ready (10s timeout)
        await broadcast(room, {
            'type': 'phase_change',
            'phase': 'intro',
            'part': 0,
            'q_index': 0,
            'question': '',
            'time_limit': 0,
        })
        await wait_all_ready(room, timeout=15)

        # ── Part 1: 4 questions ──
        room.current_part = 1
        for qi in range(4):
            room.q_index = qi
            q = room.questions_part1[qi]
            room.current_question = q
            room.answers_received = set()

            await broadcast(room, {
                'type': 'phase_change',
                'phase': 'part1',
                'part': 1,
                'q_index': qi,
                'question': q,
                'time_limit': 45,
            })

            # Start timer
            room.timer_end = time.time() + 45
            await run_timer(room, 45)

            # Broadcast timer_end
            await broadcast(room, {'type': 'timer_end'})

            # Wait briefly for stragglers
            await asyncio.sleep(1)

            # Score all answers in parallel
            await score_all_answers(room, q, 1)

            # Wait for all ready (10s timeout)
            await wait_all_ready(room, timeout=10)

        # ── Part 2 transition ──
        room.current_part = 2
        room.q_index = 0
        room.answers_received = set()

        # Part 2 prep
        await broadcast(room, {
            'type': 'phase_change',
            'phase': 'part2-prep',
            'part': 2,
            'q_index': 0,
            'question': room.part2_topic['topic'],
            'time_limit': 60,
            'part2_topic': room.part2_topic,
        })
        room.timer_end = time.time() + 60
        await run_timer(room, 60)
        await broadcast(room, {'type': 'timer_end'})

        # Part 2 speak
        room.current_question = room.part2_topic['topic']
        await broadcast(room, {
            'type': 'phase_change',
            'phase': 'part2-speak',
            'part': 2,
            'q_index': 0,
            'question': room.part2_topic['topic'],
            'time_limit': 120,
        })
        room.timer_end = time.time() + 120
        await run_timer(room, 120)
        await broadcast(room, {'type': 'timer_end'})
        await asyncio.sleep(1)

        # Score Part 2
        await score_all_answers(room, room.part2_topic['topic'], 2)
        await wait_all_ready(room, timeout=10)

        # ── Part 3: 3 questions ──
        room.current_part = 3
        for qi in range(3):
            room.q_index = qi
            q = room.part3_questions[qi]
            room.current_question = q
            room.answers_received = set()

            await broadcast(room, {
                'type': 'phase_change',
                'phase': 'part3',
                'part': 3,
                'q_index': qi,
                'question': q,
                'time_limit': 60,
            })
            room.timer_end = time.time() + 60
            await run_timer(room, 60)
            await broadcast(room, {'type': 'timer_end'})
            await asyncio.sleep(1)

            await score_all_answers(room, q, 3)
            await wait_all_ready(room, timeout=10)

        # ── Final verdict ──
        room.status = 'scoring'
        await broadcast(room, {'type': 'phase_change', 'phase': 'scoring', 'part': 0, 'q_index': 0, 'question': '', 'time_limit': 0})

        # Compute verdicts in parallel
        verdict_tasks = {}
        for username, player in room.players.items():
            if player.connected:
                verdict_tasks[username] = asyncio.create_task(compute_verdict_server(player.answers))

        leaderboard = []
        for username, task in verdict_tasks.items():
            try:
                v = await task
            except Exception:
                v = {'scores': {'FC': 5, 'LR': 5, 'GRA': 5, 'Pron': 6}, 'overall': 5.5, 'verdict': 'Assessment unavailable.', 'comment': '', 'reaction': 'disappointed'}
            player = room.players[username]
            player.final_verdict = v
            leaderboard.append({
                'username': username,
                'display_name': player.display_name,
                'scores': v['scores'],
                'overall': v['overall'],
                'verdict': v.get('verdict', ''),
                'comment': v.get('comment', ''),
            })

        # Sort by overall score descending
        leaderboard.sort(key=lambda x: x['overall'], reverse=True)

        # Assign verdicts
        for i, entry in enumerate(leaderboard):
            entry['rank'] = i + 1
            entry['verdict_label'] = 'NOT GUILTY' if i == 0 else 'GUILTY'

        room.status = 'done'
        await broadcast(room, {
            'type': 'verdict_result',
            'leaderboard': leaderboard,
        })

    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[Room {room.code}] Game loop error: {e}")
        try:
            await broadcast(room, {'type': 'error', 'message': 'Game error occurred.'})
        except Exception:
            pass

async def run_timer(room: Room, seconds: int):
    """Run a timer, broadcasting sync every 5 seconds."""
    for elapsed in range(seconds):
        await asyncio.sleep(1)
        remaining = seconds - elapsed - 1
        if remaining >= 0 and remaining % 5 == 0:
            await broadcast(room, {'type': 'timer_sync', 'remaining': remaining})
        # Check if all have submitted early
        connected = {u for u, p in room.players.items() if p.connected}
        if connected and room.answers_received >= connected:
            break

async def wait_all_ready(room: Room, timeout: int = 10):
    """Wait for all connected players to send 'ready', or timeout."""
    room.ready_received = set()
    deadline = time.time() + timeout
    while time.time() < deadline:
        connected = {u for u, p in room.players.items() if p.connected}
        if connected and room.ready_received >= connected:
            break
        await asyncio.sleep(0.3)

async def score_all_answers(room: Room, question: str, part: int):
    """Score all players' latest answers for this question in parallel."""
    tasks = {}
    for username, player in room.players.items():
        if not player.connected:
            continue
        # Find the answer for this question (latest matching one)
        answer_text = '(No answer provided)'
        for a in reversed(player.answers):
            if a.get('question') == question and a.get('part') == part:
                answer_text = a.get('answer', answer_text)
                break
        else:
            # Player didn't submit — add empty answer
            player.answers.append({'part': part, 'question': question, 'answer': answer_text})
        tasks[username] = asyncio.create_task(score_answer_server(answer_text, question, part))

    for username, task in tasks.items():
        try:
            result = await task
        except Exception:
            result = {'reaction': 'concerned', 'comment': 'The court could not evaluate.', 'objection': None, 'scores': {'FC': 5, 'LR': 5, 'GRA': 5, 'Pron': 6}}

        player = room.players.get(username)
        if not player:
            continue

        # Attach scores to the answer
        for a in reversed(player.answers):
            if a.get('question') == question and a.get('part') == part:
                a['scores'] = result.get('scores')
                break

        # Send individual feedback
        await send_to(player, {
            'type': 'ai_feedback',
            'reaction': result.get('reaction', 'neutral'),
            'comment': result.get('comment', ''),
            'objection': result.get('objection'),
            'scores': result.get('scores'),
        })

    # Broadcast all done
    await broadcast(room, {'type': 'all_feedback_done'})

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

# ─── MULTIPLAYER ENDPOINTS ───────────────────────────────────────────────────

@app.post("/api/room/create")
async def create_room(session: dict = Depends(require_auth)):
    code = generate_room_code()
    room = Room(code=code, host=session["username"])
    rooms[code] = room
    return {"code": code}

@app.get("/api/room/{code}")
async def get_room(code: str):
    room = rooms.get(code.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return room_state_msg(room)

@app.websocket("/ws/game/{room_code}")
async def ws_game(websocket: WebSocket, room_code: str, token: str = Query("")):
    # Auth — try query param first, then cookie
    if not token:
        token = websocket.cookies.get("nick_token", "")
    s = get_session(token)
    if not s:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    room_code = room_code.upper()
    room = rooms.get(room_code)
    if not room:
        await websocket.close(code=4004, reason="Room not found")
        return

    if room.status != 'lobby' and s["username"] not in room.players:
        await websocket.close(code=4003, reason="Game already in progress")
        return

    await websocket.accept()
    username = s["username"]
    display_name = s["display_name"]

    # Add or reconnect player
    if username in room.players:
        room.players[username].ws = websocket
        room.players[username].connected = True
    else:
        room.players[username] = Player(
            username=username,
            display_name=display_name,
            ws=websocket,
        )

    # Broadcast updated room state
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

        # Clean up empty rooms
        if all(not p.connected for p in room.players.values()):
            if room.game_task:
                room.game_task.cancel()
            rooms.pop(room_code, None)

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

# ─── ENTRYPOINT ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
