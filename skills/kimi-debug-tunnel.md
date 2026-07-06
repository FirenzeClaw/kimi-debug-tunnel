---
name: kimi-debug-tunnel
description: 当需要操作 kimi-debug-tunnel MCP 工具时使用——创建任务 session、向 Kimi Code CLI session 发送 prompt、执行多步工作流、监听 session 完成状态、轮询 session 状态。也适用于当前 session 中存在 execute_prompt / chat_with_session / run_flow / watch_session / create_session / poll_session / list_sessions 等 MCP 工具时。
---

# Kimi Debug Tunnel — MCP 使用规范

## 概述

kimi-debug-tunnel 是一个 MCP 服务器，通过 REST + WebSocket 协议代理 Kimi Code CLI 的 session 操作。所有工具**即发即返**，绝不在当前 turn 内阻塞等待任务 session 回复。

## 核心铁律

> **提交 prompt 后，必须用 `Bash(run_in_background=true)` 后台轮询等待回执，绝不在当前 turn 内阻塞。**

| 规则 | 违反后果 |
|------|----------|
| 即发即返，不阻塞 | MCP 超时截断，任务 session 仍在跑但你拿不到结果 |
| 后台 bash 轮询 | OS 进程信号驱动，零 token 等待，完成时 `<notification>` 自动注入 |
| 不用 `wait=true` | wait 参数已废弃，受 MCP 超时限制 |
| 不在同一 turn 反复 poll | 浪费 token，且 session 未完成时空等 |

## 工具速查

### Session 管理
| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `create_session` | 创建新 Kimi Code session | `cwd`, `permission_mode`(auto/manual/yolo), `model`, `thinking` |
| `list_sessions` | 列出所有 session | `limit` |
| `get_session_info` | 查看 session 详情（含 wirePath） | `session_id` |

### 任务下发（即发即返）
| 工具 | 用途 | 返回 |
|------|------|------|
| `execute_prompt` | 发送 prompt 到指定 session | `{submitted, poll_command}` |
| `chat_with_session` | 同 execute_prompt 的别名 | `{submitted, poll_command}` |
| `run_flow` | 创建 session + 逐步执行 | `{submitted}` — 用 `list_sessions` 找 [WF] session |
| `execute_workflow` | 加载模板 + 逐步执行 | `{submitted}` — 用 `list_sessions` 找 [WF] session |

### 状态查询
| 工具 | 用途 |
|------|------|
| `poll_session` | 结构化轮询 session 状态（active/swarm/awaiting/done/idle） |
| `list_io_records` | 快速查看 prompt + 回复对（过滤 tool_call/thinking 噪音） |
| `read_session_log` | 读取 wire.jsonl 日志详情 |
| `get_tunnel_status` | 隧道自身状态（wireConnected, 客户端数, 运行时间） |

### 后台监听
| 工具 | 用途 |
|------|------|
| `watch_session` | 启动 WS 后台监听，等待 session 完成 |
| `get_watch_result` | 非阻塞获取监听结果 |
| `continue_watch` | 拿结果 + 自动发下一步 + 启动新监听（自动化循环） |

### 工作流模板
| 工具 | 用途 |
|------|------|
| `learn_workflow` | 从描述或历史 session 学习工作流模板 |
| `list_templates` | 列出可用模板 |
| `execute_workflow` | 执行模板（创建 session → 逐步驱动） |
| `continue_workflow` | 对暂停工作流做决策（retry/skip/abort/manual） |

## 标准工作流

### 模式 A：单任务 session（最常用）

```
① create_session(cwd="/path", permission_mode="auto")
   → { session_id }

② execute_prompt(session_id, "任务描述", auto_mode=true)
   → { submitted: true, poll_command: "..." }

③ Bash(run_in_background=true, command=poll_command)
   → 后台轮询，完成时自动通知

④ 等待 <notification> → 读取 output.log → 拿到回复
```

**`poll_command` 已由工具自动生成**，包含跨平台 python 自检测（`$PY`）。直接传给 `Bash(run_in_background=true)` 即可，不要修改。

### 模式 B：多步流程

```
① run_flow(cwd="/path", steps=["步骤1", "步骤2", ...])
   → { submitted: true }

② list_sessions → 找到标题 [WF] run-flow-* 的新 session
③ 对该 session 执行模式 A 的 ③④ 步骤
```

### 模式 C：模板驱动

```
① list_templates → 选模板名
② execute_workflow(template_name)
   → WebSocket 实时推送进度到 workflow-console.html
```

## 状态含义

| `poll_session` state | 含义 | 处理 |
|----------------------|------|------|
| `active` | 正在执行工具调用 | 继续等 |
| `swarm` | 并行子代理调度中 | 继续等 |
| `awaiting_approval` | 等待审批 | 检查 auto_mode 是否启用 |
| `done` | turn 完成 (end_turn) | 可以读取回复 |
| `error` | 检测到错误 | 查看 log |
| `idle` | 空闲 | session 可能刚启动或卡住 |

## 关键约束

1. **不要在同一 turn 内多次调用 MCP 工具轮询** — 每次调用消耗 token，且大部分时间 session 仍在运行
2. **一个后台 bash 任务只轮询一个 session** — 多 session 用多个后台任务
3. **后台 bash 任务收到通知后再读取 output.log** — 不要提前 TaskOutput
4. **auto_mode=true 时不需要手动审批** — 工具调用自动通过
5. **create_session 的 permission_mode="auto" 是 session 级别** — 后续 prompt 也需要 auto_mode=true

## 常见错误

| 错误 | 正确做法 |
|------|----------|
| `execute_prompt(wait=true)` | 永远不用 wait，用后台 bash 轮询 |
| 在同一 turn 内反复调用 `list_io_records` | 启动后台 bash，等通知 |
| 不传 `auto_mode=true` 导致 session 卡在 awaiting_approval | 除非需要人工审批，否则传 true |
| 手动拼接 poll 命令 | 直接用工具返回的 `poll_command` |
| 用 `poll_session` 做高频轮询 | `poll_session` 是抽查工具，高频轮询用 bash curl |

## 红线 — 立即停止并修正

- "我手动轮询几次看看" → 启动后台 bash 任务
- "这次任务很简单，阻塞等也没事" → MCP 超时 30s，必截断
- "用 wait=true 更方便" → wait 已废弃，始终即发即返
- "直接把 poll_command 改一下" → 不要修改，工具已生成完整正确命令

**以上所有都意味着：用后台 bash 轮询，不要阻塞。**
