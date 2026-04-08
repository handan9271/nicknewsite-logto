# Nick Speaking Platform

雅思口语 AI 升级平台 — 尼克国际教育内测版

## 本地运行

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY

# 3. 启动
uvicorn main:app --reload --port 8000

# 4. 访问
open http://localhost:8000
```

默认账号：`nick` / `123456`，`student1` / `password123`

## 添加用户

```bash
python3 gen_password.py
```

按提示输入账号密码，把生成的 JSON 加入 `users.json`。

## Zeabur 部署

1. Push 到 GitHub（`.env` 已在 `.gitignore` 里，不会上传）
2. Zeabur → New Project → Import GitHub repo
3. 设置以下**环境变量**：

| 变量名 | 说明 |
|--------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `USERS_JSON` | 用户列表 JSON 字符串（见下方格式） |
| `SECURE_COOKIE` | `true`（Zeabur 有 HTTPS） |

`USERS_JSON` 格式示例：
```json
[{"username":"nick","password_hash":"8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92","display_name":"Nick 老师"},{"username":"student1","password_hash":"0a041b9462caa4a31bac3567e0b6e6fd9100787db2ab433d96f6d178cabfce90","display_name":"同学甲"}]
```

4. 选 Region: **Hong Kong**
5. 等待部署完成，绑定域名

## 密码哈希

`users.json` 里存的是 SHA-256 哈希，不是明文密码。

```bash
# 快速生成某个密码的哈希
python3 gen_password.py mypassword
```

内置示例账号：
- `nick` / `123456`
- `student1` / `password123`
