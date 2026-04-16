# Git Log

> 按阶段分组，时间倒序（最新在上）。日期为 commit 作者时间（UTC+10）。

## nicknewsite-logto 仓库

### 📦 尼克表情系统扩展（2026-04-17）

| Commit | Date | Message |
|--------|------|---------|
| 6b3b2bb | 2026-04-17 | feat: 新增 4 个尼克表情（困倦/沉思/赞许/恼火）+ 中文彩蛋 |
| 0e9eb22 | 2026-04-17 | feat: 尼克 20 种行为反应系统（输入速度/闲置/删除/高级词等） |
| 5b9b8be | 2026-04-17 | feat: NPC 音效包 + 6 种有声反应（中文/长闲置/3秒/暂停/删除/提交） |
| de45f96 | 2026-04-17 | feat: 单 Part 练习模式（可选 Part 1/2/3 单独练习+评分） |

### 📦 教师面板 — 模考报告详情 + PDF（2026-04-15）

| Commit | Date | Message |
|--------|------|---------|
| b460931 | 2026-04-15 | feat: 教师面板模考报告详情弹窗 + PDF 下载 |
| 764b99c | 2026-04-15 | feat: 教师面板练习记录可点击查看详情（题目+学生回答+AI诊断） |
| c6af912 | 2026-04-15 | fix: 语音模式暂停开麦后对话框清空问题 |
| 2702557 | 2026-04-15 | feat: 口语模考游戏手机适配（全面响应式布局） |
| 653fb8e | 2026-04-15 | fix: 手机适配修复（目标分数居中、对话框居中、继续箭头定位） |
| 447b566 | 2026-04-15 | fix: iOS 输入框缩放 + 对话框居中修复 |
| 3b4b961 | 2026-04-15 | fix: 手机端输入框字体改为 Ark Pixel |
| b06a7e9 | 2026-04-15 | feat: 判决词+评语中文毒舌化 + 历史记录提示动态化 |

### 📦 字数限制（2026-04-15）

| Commit | Date | Message |
|--------|------|---------|
| 9bf6a17 | 2026-04-15 | feat: 口语练习 + 模考游戏加入字数硬限制（P1:150/P2:300/P3:250） |
| df1ab53 | 2026-04-15 | fix: 语音模式字数计数不更新 + 练习页按钮禁用优化 |
| e99bbf8 | 2026-04-15 | fix: 录音按钮改为"开麦" |

### 📦 游戏 UI 中文化（2026-04-15）

| Commit | Date | Message |
|--------|------|---------|
| ccde6a5 | 2026-04-15 | feat: 游戏 UI 全面中文化 + 引入中文像素字体（Ark Pixel + Zpix） |

### 📦 暂停按钮迭代（2026-04-15）

| Commit | Date | Message |
|--------|------|---------|
| b6cac1b | 2026-04-15 | fix: 多人模式隐藏 PAUSE 按钮（对其他玩家不公平） |
| 09ee5ca | 2026-04-15 | fix: PAUSE 和 RESUME 都是红色背景 |
| 6064354 | 2026-04-14 | fix: 暂停按钮改为红色高亮（PAUSE 深蓝，RESUME 红色背景+红色边框） |
| 83c418e | 2026-04-14 | feat: 模考回答时加暂停/继续按钮 |

### 📦 AI 评分校准（2026-04-14）

| Commit | Date | Message |
|--------|------|---------|
| 188a1cc | 2026-04-14 | feat: AI 评分 V2 校准（few-shot + 严格 GRA + train/test 分离验证） |
| 008f08b | 2026-04-14 | feat: AI 评分校准（36 个真实样本验证） |

### 📦 目标分数 + 学习报告融合（2026-04-14）

| Commit | Date | Message |
|--------|------|---------|
| de1ec01 | 2026-04-14 | feat: 学习报告生成加入模考详细分析数据 |
| e707abb | 2026-04-14 | fix: 学生水平高于目标分数时的处理逻辑 |
| 3d40131 | 2026-04-14 | fix: 基础版最低改为 Band 4（Band 5 目标时基础版为 Band 4 而非 Band 5） |
| 87aaea1 | 2026-04-14 | feat: 口语练习目标分数选择（Band 5/6/7/8/9） |

### 📦 Verdict 页面 + PDF 报告（2026-04-14）

| Commit | Date | Message |
|--------|------|---------|
| 0063a4b | 2026-04-14 | feat: verdict 页面精简 + 模考报告移到历史记录 |
| cd36a37 | 2026-04-14 | feat: 模考报告直接在页面内显示（不再强制下载 PDF） |
| 21459df | 2026-04-14 | fix: 进度条加粗 + 秒数完全对齐 |
| 5a7ace4 | 2026-04-14 | fix: 倒计时秒数与进度条垂直对齐 |
| 1108eee | 2026-04-14 | fix: 倒计时秒数移到输入框进度条旁边（而不是右上角 HUD） |
| bd2e250 | 2026-04-14 | feat: 模考倒计时调整 + 秒数显示 |
| 15675b2 | 2026-04-14 | fix: PDF 生成 Unicode 字符报错（em dash 等特殊字符） |
| 823983f | 2026-04-14 | feat: 后端生成详细 PDF 模考报告（AI 分析 + 中文支持） |

### 📦 口语模考题库 + Part 检测（2026-04-13）

| Commit | Date | Message |
|--------|------|---------|
| 3f1681d | 2026-04-14 | fix: verdict 页面两个按钮对齐 + 统一大小 |
| 48188fd | 2026-04-14 | fix: Part 2 cue card 显示问题 + 智能 cue card 提示点 |
| d6f7ca6 | 2026-04-13 | feat: 口语模考游戏流程优化 |
| 236e06d | 2026-04-13 | fix: 口语模考题库加载时序问题 — 点击开始时题库尚未加载完 |
| 1897059 | 2026-04-13 | fix: 口语模考 Band 选择按钮不显示 — 缺少 CSS flex 布局 |
| fa12d28 | 2026-04-13 | rename: Band 6/7/8 → 目标分数 6/7/8 |
| 109234d | 2026-04-13 | fix: Part 检测提示不跟随题库选题 + 正则修复 |
| a5c2b2e | 2026-04-13 | fix+feat: Part 检测修复 + 三个 Part 写作风格更新 |
| 4d3b884 | 2026-04-13 | feat: 574 道真题题库 + 口语模考按主题出题 + 练习页题库浏览器 |

### 📦 Stage 4：学习曲线 + VIP 体系（2026-04-11）

| Commit | Date | Message |
|--------|------|---------|
| 6cc98c3 | 2026-04-11 | 🚨 fix: 严重 Bug — DatabaseSessionStorage 全局共享导致所有用户共用一个 Logto session |
| 7bb8dd2 | 2026-04-11 | feat: 老师手写学习计划 + AI 优化润色 |
| 1fc9056 | 2026-04-11 | feat: Stage 4 — 学习曲线 + 阶段成就 + VIP 体系 |
| 845e43d | 2026-04-11 | rename: 口语诊断练习→口语练习，雅思口语模考→口语模考 |

### 📦 Stage 3：全功能管理后台（2026-04-11）

| Commit | Date | Message |
|--------|------|---------|
| 1a7364b | 2026-04-11 | feat: Stage 3 — 全功能管理后台升级 |
| 48b84b5 | 2026-04-11 | fix: 多项用户体验改进 + 积分计费 bug 修复 |
| 43aac43 | 2026-04-11 | revert: 移除 Logto 用户缓存（导致登录不一致） |
| d0a5c38 | 2026-04-11 | perf+feat: Logto 用户缓存（5 分钟）+ 学习报告可编辑+复制 |

### 📦 Stage 2：角色系统 + 教师面板（2026-04-09）

| Commit | Date | Message |
|--------|------|---------|
| 8aa0877 | 2026-04-09 | feat: DeepSeek 多 Key 轮询，支持更高并发 |
| 868edfb | 2026-04-09 | feat: Stage 2 — 角色系统 + 管理后台 + 教师面板 |
| ae27cd7 | 2026-04-09 | feat: 游戏模考记录持久化 + Stage 2 规划 |
| a648dd1 | 2026-04-09 | docs: Stage 1 MVP 里程碑标记 + Stage 2 升级方向 |
| 814ee3c | 2026-04-09 | docs: 添加 CLAUDE.md 项目指南 + 更新 GIT_LOG.md |

### 📦 Stage 0：项目起步（2026-04-08）

| Commit | Date | Message |
|--------|------|---------|
| 40c50db | 2026-04-08 | feat: 升级到 Logto OAuth + 数据库 + 积分 + 历史记录 |
| 1317ba2 | 2026-04-08 | sync: 完整同步 nick-newsite 所有文件（含游戏、指南等） |
| bce663a | 2026-04-08 | feat: initial commit（从 nick-speaking 复制） |

---

## 原始 nick-newsite 仓库历史

| Commit | Date | Message |
|--------|------|---------|
| c7ccef1 | 2026-04-08 | docs: update GIT_LOG.md |
| cba92ee | 2026-04-08 | feat: add user guide page with sidebar link |
| dbe86e3 | 2026-03-28 | docs: add GIT_LOG.md with commit history |
| 49cf358 | 2026-03-28 | feat: auto-advance dialogues in multiplayer mode |
| 4e8337c | 2026-03-27 | fix: read WebSocket auth token from cookie when query param is empty |
| f9f0fca | 2026-03-27 | fix: ensure username is loaded before creating/joining multiplayer room |
| 1177d50 | 2026-03-27 | feat: add multiplayer courtroom mode with WebSocket game rooms |
| 8d32311 | 2026-03-27 | feat: 雅思口语模考 — 逆转裁判风格考官模拟器 |
| 3fd9cb3 | 2026-03-23 | feat: initial commit |

---

## 关键里程碑速查

| 日期 | 里程碑 | 关键 commit |
|------|--------|------------|
| 2026-04-08 | 项目起步（Logto + DB + 积分） | 40c50db |
| 2026-04-09 | Stage 1 MVP 上线 + Stage 2 完成 | 868edfb |
| 2026-04-11 | Stage 3（管理后台）+ Stage 4（VIP/学习曲线） | 1a7364b, 1fc9056 |
| 2026-04-11 | 🚨 Logto session 全局串号 bug 修复 | 6cc98c3 |
| 2026-04-13 | 574 题真题库 + Part 检测 | 4d3b884 |
| 2026-04-14 | PDF 模考报告 + 目标分数选择 | 823983f, 87aaea1 |
| 2026-04-14 | AI 评分 V2 校准（36 样本验证） | 188a1cc |
| 2026-04-15 | 多人模式暂停按钮定型 | b6cac1b |
| 2026-04-15 | 游戏 UI 全面中文化 + Ark Pixel/Zpix 字体 | ccde6a5 |
