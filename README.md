# Nick Speaking Platform (Logto Edition)

雅思口语 AI 升级平台 — 尼克国际教育

## 新增功能（vs nick-newsite）

- **Logto OAuth 认证** — Google / 邮箱登录，替代账号密码
- **数据库持久化** — SQLAlchemy（SQLite 开发 / MySQL 生产）
- **积分系统** — 20 次/用户，每次 AI 调用扣 1
- **历史记录** — 对话自动保存，随时回顾
- **安全加固** — 安全头、速率限制、CORS 配置

## 本地运行

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY 和 LOGTO_* 配置

# 3. 启动
uvicorn main:app --reload --port 8000

# 4. 访问
open http://localhost:8000
```

## Logto 配置

1. 在 [Logto Console](https://cloud.logto.io/) 创建 Traditional Web 应用
2. 设置回调 URL: `http://localhost:8000/auth/callback`（开发）或 `https://your-domain.com/auth/callback`（生产）
3. 设置登出 URL: `http://localhost:8000/`（开发）或 `https://your-domain.com/`（生产）
4. 将 Endpoint、App ID、App Secret 填入 `.env`

## Zeabur 部署

1. Push 到 GitHub
2. Zeabur → New Project → Import GitHub repo
3. 设置环境变量：

| 变量名 | 说明 |
|--------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `LOGTO_ENDPOINT` | Logto Endpoint URL |
| `LOGTO_APP_ID` | Logto App ID |
| `LOGTO_APP_SECRET` | Logto App Secret |
| `BASE_URL` | 你的域名（如 `https://xxx.zeabur.app`） |

4. 可选：添加 MySQL 服务，Zeabur 会自动设置 `DATABASE_URL`
5. Region 推荐 **Hong Kong**
