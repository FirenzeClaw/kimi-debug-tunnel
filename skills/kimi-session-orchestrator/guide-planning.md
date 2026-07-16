# 规划派发与验收 — 速查指南

> PM 选择「规划派发与验收」维度后加载。聚焦工作拆解、并行派发、结果审查、合成交付。
> 注意力管理、Session 退役、离线处理等长轮次编排内容见 `guide-orchestration.md`。

---

## 一、角色定位

你是 **PM 规划派发者**。核心流程：

```
拆解工作包 → 并行派发 task session → 收集审查 → 合成交付
```

- 收到需求后先侦察（读 spec/AGENTS.md），再拆任务
- 能并行的绝不串行，每个 session 职责单一
- 不盲目转发 task session 输出——先审查，再合成

---

## 二、工作分解（WBS）

### 四大原则

| 原则 | 说明 |
|------|------|
| **单一职责** | 每个包只做一件事 |
| **独立可验** | 产出可独立判断成功/失败 |
| **边界清晰** | 输入输出明确，无歧义 |
| **粒度适中** | 单个包 5-30 分钟可完成 |

### 依赖标注

```
工作包 A: 审查 data-model       ← 无依赖，可立即启动
工作包 B: 审查 contract         ← 无依赖，可与 A 并行
工作包 C: 综合审计报告           ← 依赖 A + B 完成
```

---

## 三、Prompt 编写规范

给 task session 的 prompt 必须包含 5 要素：

```
1. 上下文  — 引用相关 spec/contract 路径（已通过 memory injection 注入时可省略）
2. 具体任务 — 一句话描述要做什么
3. 明确产出 — 期望的输出格式和内容
4. 成功标准 — 什么情况下算完成
5. 边界约束 — 不要做什么、不要改什么
```

**好 prompt：**
> "审查 `specs/003/data-model.md` 中 `DrawCall` 定义与 `frame_graph.h` 源码一致性。逐字段对比，列出差异。只读不写。"

**差 prompt：**
> "检查一下 Phase 3"

---

## 四、并行编排

```
① 拆解 N 个独立工作包
② 同时创建 N 个 session
③ 同时提交 N 个 prompt（即发即返）
④ 同时启动 N 个后台 Bash 轮询
⑤ 哪个先完成就先处理哪个
⑥ 全部完成后进入合成阶段
```

**反模式：** 等一个 session 完成再启动下一个 → 浪费并行度。

---

## 五、Q2b 派发模式

> Q2b 是「规划派发与验收」维度下的两种派发子模式，按任务复杂度选择。

### 模式 1：纯派发验收

PM 拆解工作包 → 派发 task session 执行 → PM 对照设计文档与代码实现验收

**适用场景：**
- 任务简单明确，task session 一次执行即可完成
- PM 掌握最终质量判断权，审查与执行彻底分离
- 工作包独立，不涉及跨包依赖或迭代

**流程：**
```
PM 拆解 → create_session → execute_prompt → 后台轮询 →
收到产出 → PM 对照 spec/design doc 审查 → 合格 → 进入合成
```

### 模式 2：派发+自审

PM 拆解工作包 → 派发 task session 执行 → task session 自行审查修复 → PM 最终验收

**适用场景：**
- 任务需要多轮迭代（审查→修复→验证）
- 同模块连续工作同 session 完成（⛔ 铁律见 SKILL.md §关键约束 第7条）
- PM 信任 session 自审能力，但仍保留最终验收权

**流程：**
```
PM 拆解 → create_session → execute_prompt("执行 X，完成后用 selftest skill 自审并修复") →
后台轮询 → session 返回（含自审修复结果）→ PM 最终验收 → 合格 → 进入合成
```

### 模式选择速查

| 条件 | 推荐模式 |
|------|---------|
| 任务简单、单轮可完成 | 纯派发验收 |
| 任务需要多轮迭代（审查→修复→验证） | 派发+自审 |
| 强相关任务（同一模块的连续工作） | 派发+自审（合并到一个 session） |
| PM 需要严格把关每一轮产出 | 纯派发验收 |

---

## 六、结果审查清单

拿到 task session 产出后，PM 必须逐项检查：

```
□ 是否完成了 prompt 要求的所有内容？
□ 产出格式是否符合预期？
□ 引用的文件路径和行号是否准确？
□ 有没有明显的遗漏或矛盾？
□ 如果产出是代码——编译能通过吗？逻辑正确吗？
□ 如果产出是报告——结论与证据一致吗？
```

> 不合格 → 重试/修正；合格 → 进入合成。

---

## 七、标准工作流
### 单任务 session（最常用）
① create_session(cwd="/path", permission_mode="auto", memory_level="standard")
   → { session_id }
   → 自动注入记忆索引

② execute_prompt(session_id, "任务描述", auto_mode=true)
   → { submitted: true, poll_command: "..." }

③ Bash(run_in_background=true, command=poll_command)
   → 后台轮询，完成时自动通知

④ 等待 <notification> → 读取 output.log → 拿到回复

> ⛔ **poll_command 必须原样使用，禁止手写改写。** `execute_prompt` 返回的 `poll_command` 已正确格式化（v2.8.4）：`fetch_result` 用 Python `urllib.request` 直连 HTTP（无 curl 管道截断）+ `PYTHONIOENCODING=utf-8`。**直接传给 Bash，一字不改。**

---
## 八、状态含义
| state | 含义 | 处理 |
|-------|------|------|
| `active` | 正在执行工具调用 | 继续等 |
| `swarm` | 并行子代理调度中 | 继续等 |
| `awaiting_approval` | 等待审批 | 确认 auto_mode=true |
| `done` | turn 完成 | 可读回复 |
| `error` | 检测到错误 | 查看 log |
| `idle` | 空闲等待 | 可能刚启动或卡住 |
---

## 九、合成与交付

所有工作包审查通过后：

```
① 汇总所有 session 的产出
② 去重、排序、建立逻辑关联
③ 形成单一可交付物（报告 / PR / 文件变更列表）
④ 标注未覆盖项、已知风险、后续建议
⑤ 以结构化格式输出（表格 + 分类 + 严重度标注）
```

---

## 十、工具速查

### Session 管理
| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `create_session` | 创建新 session，自动注入记忆索引 | `cwd`, `permission_mode`, `model`, `thinking`, `memory_level`, `policy` |
| `list_sessions` | 列出所有 session | `limit` |
| `get_session_info` | 查看 session 详情（含 wirePath） | `session_id` |

### 任务下发
| 工具 | 用途 | 返回 |
|------|------|------|
| `execute_prompt` | 发送 prompt 到指定 session | `{submitted, poll_command}` |
| `chat_with_session` | 同 execute_prompt 的别名 | `{submitted, poll_command}` |
| `run_flow` | 创建 session + 逐步执行 | `{submitted}` |
| `execute_workflow` | 加载模板 + 逐步执行 | `{submitted}` |

### 状态查询
| 工具 | 用途 |
|------|------|
| `poll_session` | 结构化轮询 session 状态（active/swarm/awaiting/done/idle） |
| `list_io_records` | 快速查看 prompt + 回复对（过滤 tool_call/thinking 噪音） |
| `read_session_log` | 读取 wire.jsonl 日志详情 |
| `get_tunnel_status` | 隧道自身状态（wireConnected, 客户端数, 运行时间） |

### 共享记忆
| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `memory_set` | 写入键值对到命名空间 | `namespace`, `key`, `value`, `project`（可选） |
| `memory_get` | 读取记忆条目 | `namespace`, `key`（可选）, `project`（可选） |
| `memory_list` | 列出命名空间 | `namespace`（可选）, `project`（可选） |
| `memory_status` | 知识库全景 | `project`（可选） |
| `memory_archive` | 归档 session findings → L1 learnings | `session_id`, `project`（可选） |

> `project` 参数用于跨项目记忆路由（v2.13+）。不加时行为不变。详见 `guide-cross-project-memory.md`。

### 工作流模板
| 工具 | 用途 |
|------|------|
| `learn_workflow` | 从描述或历史 session 学习模板 |
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

## 十一、红线

| 违规 | 为什么致命 |
|------|-----------|
| **跳过侦察直接开工** | 不知道项目规范和当前状态就分配工作——可能产生无效产出 |
| **盲转 task session 输出** | PM 不审查 = 放弃质量责任。你必须是最后一道防线 |
| **串行执行可并行的任务** | 2 个 15min 任务串行 = 30min，并行 = 15min |
| **不合成就直接交付** | 用户看到零散输出而非结构化结论——PM 的核心价值就是综合与提炼 |
| **不标注未覆盖项和风险** | 用户以为全部完成，实际有遗漏——制造虚假安全感 |
| **Prompt 模糊不清** | "检查代码""看看有没有问题"——session 不知道要做什么，产出不可靠 |
| **一个 session 做所有事** | 失去并行度和职责分离。出问题时无法定位是哪个任务导致的 |
| **强相关任务拆分到不同 session** | 每个 session 都需重新加载相同上下文——token 浪费 2-3 倍 |

> 完整红线见 `coordinator-guide.md` §六（含注意力管理、退役、越权控制等全部 PM 级红线）。

---

---

## Server 断联/未启动自主恢复

当 MCP 工具返回 "Wire client 未连接到 Kimi Server" 或 `get_tunnel_status` 显示 `wireConnected: false` 时，**无需等待用户指示**，自主执行以下恢复流程：

**R1 — 诊断**
`Bash: cat ~/.kimi-code/server/lock`
→ lock 存在且 PID 存活？跳 R3
→ lock 缺失或 PID 已死？进 R2

**R2 — 启动 Kimi Server**
`Bash(run_in_background=true): kimi web --no-open &`
等待 8-10s，确认 lock 文件出现且 port 字段有效。

**R3 — 等待 Tunnel 自动重连**
Tunnel 每 10s 自动检测 lock 并重试连接。等待 ≤30s。
`get_tunnel_status` 确认 `wireConnected: true`。
超过 120s 仍未恢复 → 在终端执行 `/reload` 强制重启 MCP 进程。

**R4 — 恢复状态**
- `get_tunnel_status` 确认 `wireConnected: true`
- 检查活跃 task session：`poll_session` 逐个确认状态
- 检查后台 Bash 任务：`TaskList` 查看是否因断连异常退出 → 重建
- 断连前已提交的 prompt 不受影响——继续原流程

> 完整规范见 `docs/coordinator-guide.md`
