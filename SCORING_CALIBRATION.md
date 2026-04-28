# AI 评分校准方案

> 本文件记录评分校准的完整方案、当前状态和未来计划。供 Claude Code 在后续对话中参考。

## 一、当前方案（Prompt 校准，38 个样本）

### 状态：已上线 ✅
- **MAE**: 0.31（42 个样本 leave-one-out 验证）
- **93% 的预测在真实分数 ±0.5 Band 以内**
- Commit: `f26e563`（2026-04-20）

### 原理
在 `VERDICT_PROMPT_SERVER`（main.py）和 `buildMetaPrompt`（index.html）中，嵌入 12 个真实考官打分的锚点样本（Band 5.0 到 9.0），引导 DeepSeek 对齐 Nick 的打分标准。

### 校准数据来源
- 文件夹：`/Users/dan/Desktop/模考成绩/尼克打分/`
- 格式：SRT 字幕文件，文件名 = 四项分数（FC LR GRA Pron）
- 例如：`8778.srt` → FC=8, LR=7, GRA=7, Pron=8
- 已有样本：38 个（去重后）→ 现已收集到 ~100 个

### 曾经尝试过但不如 Prompt 的方法（样本量不足时）
1. **纯 ML（Ridge / GradientBoosting）**：MAE=0.80，比 Prompt 差
2. **Isotonic Regression 修正**：MAE=0.41，也比 Prompt 差
3. **原因**：38 个样本不够训练 16 个特征的 ML 模型

---

## 二、目标方案（ML + DeepSeek 混合，需 500+ 样本）

### 状态：等待数据收集 🔄
- 目标样本数：500+
- 当前进度：~100 个
- 预期 MAE：< 0.15

### 架构

```
学生答案
    ↓
DeepSeek 提取语言学证据（不打分）
    ↓
证据 JSON:
{
  "grammar_errors": 3,        ← 语法错误数
  "complex_structures": 8,    ← 正确的复杂句数
  "advanced_vocab": 12,       ← 高级词汇数
  "basic_vocab_repeated": 5,  ← 基础词汇重复数
  "extended_responses": 4,    ← 延展性回答数
  "hesitations": 2,           ← 犹豫/重启次数
  "topic_development": "good" ← 话题展开程度
}
    ↓
ML 模型打分（从 500 个 Nick 真实打分学到的数学公式）
    ↓
分数合理吗？
    ↓              ↓
   合理           不合理（边界情况）
    ↓              ↓
  直接输出      DeepSeek 重新打分（fallback）
```

### 为什么这样设计

| 组件 | 职责 | 优势 |
|------|------|------|
| DeepSeek | 读懂英语，提取客观事实 | LLM 的语言理解能力强 |
| ML 模型 | 像 Nick 一样打分 | 稳定、一致、零额外成本 |
| Fallback | 处理边界情况 | 防止 ML 在罕见情况下出错 |

### 各维度的可靠性

| 维度 | ML 可靠度 | 原因 |
|------|----------|------|
| GRA | 高 | 语法错误率是强指标 |
| LR | 高 | 词汇丰富度可量化 |
| FC | 中高 | 回答长度+犹豫次数有相关性，但"深度"难量化 |
| Pron | 低 | 文字中无法判断发音，需用其他分数估算 |

---

## 三、数据收集规范

### SRT 文件要求
- 来源：Nick 模考录影 → 剪映/飞书妙记生成字幕 → 导出 SRT
- 内容：双语（中+英）均可，代码会自动过滤中文
- 命名：`FC LR GRA Pron.srt`（四个整数，4-9）
- 重复分数加序号：`8778.srt`、`8778(2).srt`

### 分数段覆盖目标

| Band 段 | 目标数量 | 说明 |
|--------|---------|------|
| 4-5 分 | 50+ | 基础较弱，最难收集但很重要 |
| 5.5-6.5 | 150+ | 中等水平，最常见 |
| 7-7.5 | 150+ | 中上水平 |
| 8-9 | 150+ | 高水平 |

### Nick 需要给每个学生的信息
- FC（整数 4-9）
- LR（整数 4-9）
- GRA（整数 4-9）
- Pron（整数 4-9）
- 不需要写评语，只要四个数字

---

## 四、500+ 样本收集到后的实施步骤

### Step 1：清洗数据
```python
# 解析 SRT → 分离考官/学生语音 → 输出干净 Q&A 格式
# 已有代码：使用启发式规则分离（不需要 API）
```

### Step 2：提取语言学证据
```python
# 用 DeepSeek 对每个样本提取结构化证据
# Prompt：只提取事实，不打分
# 输出：grammar_errors, complex_structures, advanced_vocab 等 16 个特征
```

### Step 3：训练 ML 模型
```python
# 用 Ridge Regression 或 GradientBoosting
# 每个维度（FC/LR/GRA/Pron）独立训练
# Leave-one-out 交叉验证评估效果
# 保存模型系数到 main.py
```

### Step 4：集成到代码
```python
# main.py 新增：
# 1. EVIDENCE_PROMPT — 让 DeepSeek 只提取证据
# 2. extract_features() — 从证据中算出数值特征
# 3. ml_score() — 用训练好的系数打分
# 4. fallback — 分数异常时用 DeepSeek 重打
```

### Step 5：验证 + 上线
```
- 全量 leave-one-out 验证
- 对比 Prompt 方法 vs ML 方法
- 确认 MAE < 0.20 后上线
- 替换 VERDICT_PROMPT_SERVER 和 buildMetaPrompt 中的评分逻辑
```

---

## 五、历史校准记录

| 日期 | 版本 | 样本数 | 方法 | MAE | Commit |
|------|------|--------|------|-----|--------|
| 2026-04-14 | V1 | 36 | Few-shot + 严格 GRA | — | `188a1cc` |
| 2026-04-14 | V2 | 36 | Train/test 分离验证 | — | `008f08b` |
| 2026-04-20 | V3 | 42 | 12 个锚点 + 校准警告 | 0.31 | `f26e563` |
| 2026-04-25 | V4 | 109 | 14 个锚点 + Band 6.0 补全 + 109样本验证 | 0.15 | 待 push |
| 待定 | V5 | 500+ | ML + DeepSeek 混合 | 目标 < 0.10 | — |

---

## 六、关键文件位置

| 文件 | 说明 |
|------|------|
| `main.py` → `VERDICT_PROMPT_SERVER` | 游戏模考评分 prompt（当前 V4） |
| `static/index.html` → `buildMetaPrompt()` | 口语练习页评分 prompt（当前 V4） |
| `main.py` → `FREE_PRACTICE_FULL_PROMPT` | 自由练习模式评分 prompt |
| `/Users/dan/Desktop/模考成绩/尼克打分/` | SRT 校准数据文件夹 |
| `/tmp/calibration_clean.json` | 清洗后的数据（临时，需重新生成） |
| `/tmp/calibration_evidence.json` | 提取的语言学证据（临时，需重新生成） |
