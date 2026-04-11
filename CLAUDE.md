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

## 里程碑

### Stage 1: MVP 上线 ✅（2026-04-09 完成）
基础功能完整可用，已部署生产环境。

**已实现：**
- [x] Logto OAuth 认证（Google/邮箱登录）
- [x] MySQL 数据库持久化（Zeabur 外部连接）
- [x] 积分系统（20次/用户，前端实时显示）
- [x] 历史记录（对话自动保存，历史页面真实数据）
- [x] 口语诊断练习（DeepSeek 流式、双语模式、Part检测、逐句对比报告）
- [x] IELTS COURT 口语模考游戏（单人 + 多人 WebSocket）
- [x] 安全加固（安全头、速率限制、CORS）
- [x] Zeabur Hong Kong 部署上线

**已知问题：**
- [ ] 品牌文案待更新（目前沿用"雅思考官尼克"）
- [ ] favicon.ico 缺失（404）

---

### Stage 2: 角色系统 + 管理后台 + 教师面板 ✅（2026-04-09/10 完成）
- [x] 三级角色：admin / teacher / student
- [x] 教师面板：添加学生、查看练习/模考记录、AI 生成学习报告
- [x] 游戏模考记录持久化
- [x] 学习报告可编辑 + 一键复制

### Stage 3: 管理后台全面升级 ✅（2026-04-11 完成）
全功能管理后台，7 大模块：

**仪表盘**
- [x] DAU/WAU/MAU 统计
- [x] 14 天使用趋势图
- [x] 热门题目 Top 10
- [x] 教师排行榜
- [x] 今日新用户/练习/模考
- [x] AI 成本估算

**用户管理**
- [x] 搜索（邮箱/姓名）+ 筛选（角色/状态）+ 排序 + 分页
- [x] 编辑用户（角色/积分/名称）
- [x] 用户详情抽屉（完整信息+历史记录+一键导出）
- [x] 批量充值（set/add 模式）
- [x] 用户禁用/启用

**班级管理**
- [x] 创建班级、分配老师
- [x] 批量添加学生（一次粘贴多个邮箱）
- [x] 自动关联到老师的学生列表
- [x] 查看/删除班级

**公告通知**
- [x] 新建/编辑/删除公告
- [x] 按角色定向（all/student/teacher/admin）
- [x] 主站顶部横幅自动显示

**内容管理**
- [x] 管理示例题目/AI Prompt/题库
- [x] 按 key 索引，可随时修改

**操作日志**
- [x] 所有 admin 操作自动记录
- [x] 查看最近 200 条日志

**数据导出**
- [x] 用户列表 CSV
- [x] 单用户完整数据 JSON

**数据库新增表：**
- `announcements` — 公告
- `audit_logs` — 操作审计
- `classes` + `class_students` — 班级
- `content_items` — 内容管理
- `users.is_disabled` + `users.last_active_at` 字段

---

### 未来候选方向
- [ ] TTS 语音朗读（OpenAI TTS API）
- [ ] 前端 UI/UX 优化（响应式、深色模式）
- [ ] 品牌升级（Logo、文案、Landing Page）
- [ ] 多语言支持
- [ ] 教师学习报告一键发送邮件给学生（需要 SMTP 配置）
- [ ] 教师学习报告一键发送微信给学生（需要企业微信/服务号认证）
- [ ] favicon.ico
- [ ] Redis 缓存（高并发时）
