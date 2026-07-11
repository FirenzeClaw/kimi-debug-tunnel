---
name: kimi-session-orchestrator
description: 当需要操作 kimi-session-orchestrator MCP 工具时使用——创建任务 session、向 Kimi Code CLI session 发送 prompt、执行多步工作流、监听 session 完成状态、轮询 session 状态。也适用于当前 session 中存在 execute_prompt / chat_with_session / run_flow / watch_session / create_session / poll_session / list_sessions 等 MCP 工具时。
---

# Kimi Session Orchestrator — PM 视角多 session 编排

---

## ⛔ 加载即执行——启动协议

**此 skill 加载后，必须完成以下三步启动对话，再处理任何用户请求：**

### 第一步：读取 PM 规范

使用 `Read` 工具读取本 skill 目录下的 `coordinator-guide.md`，建立 PM 决策框架基线。

> 跳过此步 = 盲飞。coordinator-guide 定义了 PM 角色定位、工作分解规范、注意力管理、红线——必须先建立规范基线才能开始调度。

### 第二步：确认角色与目标

向用户询问以下三个问题（用 `AskUserQuestion` 工具，一次呈现）：

**Q1: 当前 session 角色？**

| 选项 | 标签 | 含义 |
|------|------|------|
| A | PM 统筹模式 | 你是项目经理——负责拆解任务、分配 session、审查产出、合成交付。不直接执行代码 |
| B | 执行模式 | 你是执行者——当前 session 自己干活，仅用 tunnel 工具做后台编排辅助 |

**Q2: 最终目标？**

自由文本输入。示例："审查 specs/003 的全部实现，修复发现的 bug，输出审查报告"

**Q3: 决策模式？**

| 选项 | 标签 | 含义 |
|------|------|------|
| A | 自主执行 | 遇到阻塞自行判断（重试/跳过/降级），只在结果交付时汇报。不逐一等待确认 |
| B | 关键点等待 | 以下节点暂停等待用户指示：① 工作包拆解完成后 ② 每个 session 产出审查后 ③ 发现越权/幻觉等异常时 |

### 第三步：设定运行模式

根据用户回答，在后续所有操作中遵循：

- **PM 模式 + 自主执行**：按 coordinator-guide §零~§四 规范，自主完成 理解→拆解→编排→收集→合成 全流程。仅在交付时汇报
- **PM 模式 + 关键点等待**：每完成一个阶段（拆解/审查/合成）暂停，展示当前进度和下一步计划，等用户确认
- **执行模式**：不使用 PM 决策框架，仅提供工具操作辅助

---

## 核心铁律

> **提交 prompt 后，必须用 `Bash(run_in_background=true)` 后台轮询等待回执，绝不在当前 turn 内阻塞。**

| 规则 | 违反后果 |
|------|----------|
| 即发即返，不阻塞 | MCP 超时截断，任务 session 仍在跑但你拿不到结果 |
| 后台 bash 轮询 | OS 进程信号驱动，零 token 等待，完成时 `<notification>` 自动注入 |
| 不用 `wait=true` | wait 参数已废弃，受 MCP 超时限制 |
| 不在同一 turn 反复 poll | 浪费 token，且 session 未完成时空等 |

---

## 工具速查

### Session 管理
| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `create_session` | 创建新 Kimi Code session，自动注入记忆索引 | `cwd`, `permission_mode`(auto/manual/yolo), `model`, `thinking`, `memory_level`(minimal/standard/full), `policy` |
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

### 共享记忆（v2.5+）
| 工具 | 用途 |
|------|------|
| `memory_set` | 写入键值对到命名空间 |
| `memory_get` | 读取记忆条目 |
| `memory_list` | 列出命名空间 |
| `memory_status` | 知识库全景 |
| `memory_archive` | 归档 session findings → L1 learnings |

#### 记忆注入策略（v2.6）

> `create_session(memory_level)` 时自动注入**记忆索引**（非全量内容）。task session 首 turn 自主调用 `memory_get` 按需读取。

| `memory_level` | 注入内容 | 适用场景 |
|:---|:---|:---|
| `minimal` | 仅角色锚定 + key 计数，不含键名列表 | session 不需要项目背景 |
| `standard`（默认） | 命名空间 → 键名 → 读取建议，>20条自动折叠 | 常规任务，项目知识库 ≤ 50 条 |
| `full` | 完整 memory_get 输出（所有条目内容，**不使用**） | 已废弃——改用 standard + 按需自读 |

**注入格式示例（standard）**：

```
[系统注入] 你是任务 session。使用 memory_get 按需读取：

- memory_get(namespace="project/meta") — 项目背景（必读）
- memory_get(namespace="project/decisions") — 架构决策（必读）

（共 12 条可用，已折叠 2 条。用 memory_list 查看全部）
```

**红线**：
- 不要用 `full`——会把全部知识塞进 prompt，浪费 token
- task session 收到索引后必须在首 turn 调用 `memory_get` 拉取所需条目
- 不要在 `execute_prompt` 中手动拼接项目背景——注入已自动完成

> 详细规范见 `coordinator-guide.md` §1.5.7（三层内存架构 + PM 操作流程）。

### 后台监听
| 工具 | 用途 |
|------|------|
| `watch_session` | 启动 WS 后台监听，等待 session 完成 |
| `get_watch_result` | 非阻塞获取监听结果 |
| `continue_watch` | 拿结果 + 自动发下一步 + 启动新监听 |

### 工作流模板
| 工具 | 用途 |
|------|------|
| `learn_workflow` | 从描述或历史 session 学习工作流模板 |
| `list_templates` | 列出可用模板 |
| `execute_workflow` | 执行模板（创建 session → 逐步驱动） |
| `continue_workflow` | 对暂停工作流做决策（retry/skip/abort/manual） |

### 权限策略
| 工具 | 用途 |
|------|------|
| `list_policies` | 列出内置 + 自定义策略 |
| `approve_tool` | PM 放行被阻断的工具调用 |
| `deny_tool` | PM 拒绝被阻断的工具调用 |

---

## 标准工作流

### 模式 A：单任务 session（最常用）

```
① create_session(cwd="/path", permission_mode="auto", memory_level="standard")
   → { session_id }
   → 自动注入记忆索引（命名空间 + 键名 + 读取建议）到 session 首 turn

② execute_prompt(session_id, "任务描述", auto_mode=true)
   → { submitted: true, poll_command: "..." }
   → task session 首 turn 收到索引 → 自主 memory_get 拉取所需条目 → 执行任务

③ Bash(run_in_background=true, command=poll_command)
   → 后台轮询，完成时自动通知

④ 等待 <notification> → 读取 output.log → 拿到回复
```

**`poll_command` 已由工具自动生成**，包含跨平台 python 自检测。直接传给 `Bash(run_in_background=true)`，不要修改。

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
   → WebSocket 实时推送进度（浏览器扩展或 ws://localhost:<TUNNEL_PORT>/ws）
```

---

## 状态含义

| `poll_session` state | 含义 | 处理 |
|----------------------|------|------|
| `active` | 正在执行工具调用 | 继续等 |
| `swarm` | 并行子代理调度中 | 继续等 |
| `awaiting_approval` | 等待审批 | 检查 auto_mode 是否启用 |
| `done` | turn 完成 (end_turn) | 可以读取回复 |
| `error` | 检测到错误 | 查看 log |
| `idle` | 空闲 | session 可能刚启动或卡住 |

---

## 关键约束

1. **不要在同一 turn 内多次调用 MCP 工具轮询** — 每次调用消耗 token
2. **一个后台 bash 任务只轮询一个 session** — 多 session 用多个后台任务
3. **后台 bash 任务收到通知后再读取 output.log** — 不要提前 TaskOutput
4. **auto_mode=true 时不需要手动审批** — 工具调用自动通过
5. **create_session 的 permission_mode="auto" 是 session 级别** — 后续 prompt 也需要 auto_mode=true

---

## 红线 — 立即停止并修正

- "我手动轮询几次看看" → 启动后台 bash 任务
- "这次任务很简单，阻塞等也没事" → MCP 超时 30s，必截断
- "用 wait=true 更方便" → wait 已废弃，始终即发即返
- "直接把 poll_command 改一下" → 不要修改，工具已生成完整正确命令

**以上所有都意味着：用后台 bash 轮询，不要阻塞。**
