# CLAUDE.md — nicknewsite-logto 项目指南

> 本文件供 Claude Code 在每次对话开始时读取，确保上下文连贯。

## 项目概述

**Nick Speaking Platform (Logto Edition)** — 雅思口语 AI 升级平台，尼克国际教育。
- GitHub: `handan9271/nicknewsite-logto`
- 生产环境: `https://nicknewsitelogtohk.zeabur.app`
- 源项目: `handan9271/nick-newsite`（原始版本，无 Logto/数据库）

## 技术架构

### 后端 (`main.py`, ~1080 行)
- **框架**: FastAPI + Uvicorn
- **认证**: Logto OAuth（Google/邮箱登录）
- **数据库**: SQLAlchemy — SQLite（开发）/ MySQL（生产）
- **AI**: DeepSeek API，流式传输（SSE）
- **多人游戏**: WebSocket 房间制，服务器权威游戏循环

### 前端
- `static/index.html` — 主应用（口语诊断练习、双语模式、Part检测、报告渲染、历史记录）
- `static/game.html` + `game.js` + `game.css` — IELTS COURT 口语模考游戏（逆转裁判风格）
- `static/guide.html` — 使用指南
- `static/nick-preview.html` — 预览页

### 数据库表
- `users` — logto_user_id, email, display_name, credits(默认20)
- `conversations` — user_id, question, user_input, ai_reply, topic_type, score, timestamp
- `user_sessions` — Logto session 持久化存储

## 部署配置

### Zeabur (Hong Kong)
- 服务名: beeieltsv2hk
- Dockerfile: Python 3.13-slim, 端口 8080
- MySQL: 外部连接 `hkg1.clusters.zeabur.com:31307`，数据库名 `nicknewsitelogto`

### 环境变量（beeieltsv2hk 服务）
```
DEEPSEEK_API_KEY=sk-***
LOGTO_ENDPOINT=https://auth.9999ielts.cn/
LOGTO_APP_ID=gbc4xoiovnbzgc5taukj7
LOGTO_APP_SECRET=***
DATABASE_URL=mysql+pymysql://root:***@hkg1.clusters.zeabur.com:31307/nicknewsitelogto?charset=utf8mb4
BASE_URL=https://nicknewsitelogtohk.zeabur.app
```

### Logto 配置
- 租户: `auth.9999ielts.cn`
- 应用名: `nicknewsite-logto`
- Redirect URI: `https://nicknewsitelogtohk.zeabur.app/auth/callback` + `http://localhost:8000/auth/callback`
- Post sign-out URI: `https://nicknewsitelogtohk.zeabur.app/` + `http://localhost:8000/`

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 主页 (index.html) |
| GET | `/game` | 口语模考游戏 |
| GET | `/guide` | 使用指南 |
| GET | `/auth/sign-in` | Logto 登录跳转 |
| GET | `/auth/callback` | Logto 回调 |
| GET | `/auth/sign-out` | Logto 登出 |
| GET | `/api/me` | 当前用户信息 (username, display_name, email, credits) |
| POST | `/api/upgrade` | DeepSeek 流式代理 + 积分检查 |
| POST | `/api/save-conversation` | 保存对话到数据库 |
| GET | `/api/history` | 用户历史记录 |
| POST | `/api/room/create` | 创建多人游戏房间 |
| GET | `/api/room/{code}` | 查询房间状态 |
| WS | `/ws/game/{room_code}` | 多人游戏 WebSocket |
| GET | `/health` | 健康检查 |

## 关键设计决策

1. **流式代理 + 前端保存**: `/api/upgrade` 是纯流式代理，后端不解析内容。前端流式完成后调用 `/api/save-conversation` 保存。
2. **积分扣减时机**: 在 `/api/upgrade` 请求时立即扣减（流开始前），不是流完成后。
3. **WebSocket 认证**: 通过 Logto session storage 认证，不再用 `nick_token` cookie。
4. **`/api/me` 兼容性**: 返回 `username`（logto_user_id）和 `display_name`，兼容游戏前端的身份识别。

## 本地开发

```bash
cd /tmp/nicknewsite-logto
source venv/bin/activate
# .env 已配置好
uvicorn main:app --reload --port 8000
```

## 相关项目
- `handan9271/nick-newsite` — 原始版本（账号密码登录，无数据库）
- `handan9271/nick-speaking` — 更早期版本（轻量 MVP）
- `handan9271/9999ieltsonzeabur` — 雅思写作助教（Logto + OpenAI，参考架构来源）

## 待办 / 已知问题
- [ ] 品牌文案待更新（目前沿用"雅思考官尼克"）
- [ ] TTS 语音朗读功能暂未加入
- [ ] favicon.ico 缺失（404）
