---
name: session-retire
description: Use when retiring a task session and spawning a successor with full context transfer — PM detects attention decay (≥360K context, norm deviation, hallucinations, repeated work), completes a major milestone, or needs a fresh session for the next phase. Use when PM says "退役"、"接班"、"换session"、"新session继续"。Requires kimi-session-orchestrator MCP tools.
---

# Session Retire & Successor — 退役与接班

## Overview

将 coordinator-guide §1.5.4 的 7 步退役流程自动化：归档发现 → 提取上下文 → 写入共享记忆 → 创建接班 session → 注入完整上下文 → 新 session 自举。实现近乎无损的 session 接力。

## When to Use

- 任务 session 上下文达到 ~360K（注意力拐点），或出现 ≥2 个衰减信号
- PM 完成一个阶段性里程碑，需要新 session 继续下一阶段
- PM 明确说"退役"、"接班"、"换 session"、"新 session 继续"

**不适用：** 临时探索、一次性查询、< 3 轮的简短任务。

## Pipeline

### Phase 1 — 提取退役 session 上下文

以下 4 步全部并行执行（互不依赖）：

```
① get_session_info(session_id="<retiring_id>")
   → 拿到 cwd, title, wirePath

② list_io_records(session_id="<retiring_id>", limit=15, max_content_length=3000)
   → 最近 15 轮 prompt↔回复，用于提取已完成/待办/决策

③ read_session_log(session_id="<retiring_id>", limit=50)
   → 深度上下文：错误、工具调用链、阻塞点

④ memory_get(namespace="project/meta")
   memory_get(namespace="project/decisions")
   memory_get(namespace="project/learnings")
   → 项目知识基线（新 session 也需要这些）
```

**完成标准**：拿到 cwd + 最近对话摘要 + 项目知识基线。4 个调用全部返回。

### Phase 2 — 归档与持久化

```
⑤ memory_archive(session_id="<retiring_id>")
   → L2 findings → L1 project/learnings。新 session 通过 memory_level 自动获取。

⑥ memory_set(namespace="session/<retiring_id>/handoff", key="completed", value="<JSON 数组>")
   memory_set(namespace="session/<retiring_id>/handoff", key="pending",  value="<JSON 数组>")
   memory_set(namespace="session/<retiring_id>/handoff", key="decisions", value="<文本>")
   → 结构化 handoff 数据。新 session 通过 memory_get 精确读取。
```

**完成标准**：memory_archive 返回成功 + 3 条 memory_set 全部写入。若 session 无有价值的发现，memory_archive 可跳过（但 handoff 数据必须写入）。

### Phase 3 — 构建 7-Block 上下文模板

从 coordinator-guide §1.5.4 步骤⑥。**全部 7 个区块必须填写，不可留空。**

```
【项目背景】
- 项目路径: <cwd>
- 项目类型: <从 project/meta 提取>
- 当前阶段: <当前 work phase>

【规范参考】（新 session 必须先读以下文件建立基线）
- AGENTS.md: <cwd>/AGENTS.md
- 相关 spec: <列出路径，无则写"无">

【已完成工作】
1. <具体产出 — 含文件路径和关键结论>
2. ...

【当前待办】（本次 session 需要完成）
1. <任务 — 具体、可验证>
2. ...

【已做出的关键决策】（新 session 不应推翻）
- <决策: 选择方案A而非B，原因>
- ...

【权限边界】（明确禁止）
- <约束列表>

【已知风险与注意事项】
- <风险列表>
```

### Phase 4 — 启动接班 session

```
⑦ create_session(
     cwd="<cwd>",
     permission_mode="auto",
     memory_level="full",
     from_session="<retiring_id>"
   )
   → 返回 new_session_id

⑧ execute_prompt(
     session_id="<new_session_id>",
     prompt="<7-block 模板>

---
请先依次执行以下启动步骤以建立上下文基线：

1. Read <cwd>/AGENTS.md
2. memory_get(namespace="project/meta")
3. memory_get(namespace="project/decisions")
4. memory_get(namespace="project/learnings")
5. memory_get(namespace="session/<retiring_id>/handoff/completed")
6. memory_get(namespace="session/<retiring_id>/handoff/pending")
7. memory_get(namespace="session/<retiring_id>/handoff/decisions")

完成全部 7 步后回复'上下文已建立，共加载 N 条记忆，等待任务'。

⛔ 禁止在建立上下文前执行任何文件操作或代码修改。",
     auto_mode=true
   )
```

**完成标准**：create_session 返回新 ID + execute_prompt 返回 `{ submitted: true }`。

### Phase 5 — 汇报退役结果

```
退役完成:
- 退役 session: <retiring_id> → cwd: <cwd>
- 归档: N 条 finding → project/learnings
- 接班 session: <new_session_id>
- 上下文: 7-block 模板 + memory_level=full + 启动自举指令
- 下一步: 等待新 session 确认上下文建立后分派任务
```

## 启动自举协议（新 session 视角）

新 session 收到首条 prompt 后，**必须严格按顺序执行 7 个启动步骤**。此协议确保新 session 在首轮 turn 内完成上下文建立，第二轮即可直接执行任务。

**关键约束**：
- 7 步全部完成前，不得执行 Read 规范文件以外的任何文件操作
- 不得跳过任何步骤——即使某步看似不相关
- 若某步的 memory_get 返回空 → 记录"无数据"并继续
- 确认消息必须是"上下文已建立，共加载 N 条记忆，等待任务"（精确匹配以让 PM 识别）

## Edge Cases

| 场景 | 处理 |
|------|------|
| project/meta 为空 | 注明"项目知识库未初始化，建议先 memory_set 录入项目规范" |
| memory_archive 无数据可归档 | 跳过 Phase 2 步骤⑤，仅写入 handoff 数据 |
| create_session 失败 | 检查 get_tunnel_status → 确认 cwd 存在 → 重试一次 → 仍失败则报告 |
| 新 session 超时未确认上下文 | 用 poll_session 检查状态。若 idle 超过 60s → 重新发送首条 prompt |
| 退役 session 仍活跃（未 idle） | 等待其完成当前 turn → 继续。不强制中断正在执行的 session。 |
| 批量退役多个 session | 逐个处理。每个完整的 Phase 1→5 后再开始下一个。汇报时汇总。 |

## Common Mistakes

| 错误 | 后果 | 正确做法 |
|------|------|---------|
| 忘记 `from_session` | 新 session 无法自动获取退役 session 的 handoff 上下文 | create_session 必须传 from_session |
| 忘记 `memory_level="full"` | 新 session 只注入了索引，缺少完整的项目知识 | 接班场景始终用 full |
| 7-block 模板缺区块 | 新 session 不知道规范文件、权限边界、已做决策 | 全部 7 个区块必须填写，不可留空 |
| 不给新 session 时间建立上下文 | 新 session 跳过 AGENTS.md + memory_get，直接执行任务 → 偏离规范 | 等待"上下文已建立"回复后再分派任务 |
| 退役前未执行 memory_archive | session 期间的全部发现随 session 关闭而丢失 | Phase 2 步骤⑤不可跳过（除非无数据） |

## Red Lines

- 退役前未执行 memory_archive → 丢失全部发现
- create_session 未传 from_session → 接班 session 盲飞
- 新 session 首条 prompt 无启动自举指令 → session 不知道要读什么
- 上下文建立前分派任务 → 冲动操作，产出不可靠
- 7-block 模板有空白区块 → 信息缺口 = PM 失职

**违反规则的字面意思就是违反规则的精神。**

## 与 handoff / continue 的关系

| | handoff | continue | session-retire |
|---|---------|----------|----------------|
| 交接载体 | 临时 .md 文件 | 读取 .md 文件 | MCP 共享记忆 + from_session 注入 |
| 自动化程度 | 手动写文档 | 手动读文档 | 全自动 pipeline |
| 上下文完整性 | 依赖 PM 书写质量 | 依赖文件存在 | 7-block 模板保证结构完整 |
| 适用场景 | MCP 不可用时的降级方案 | MCP 不可用时的降级方案 | **MCP 可用时的首选方案** |
