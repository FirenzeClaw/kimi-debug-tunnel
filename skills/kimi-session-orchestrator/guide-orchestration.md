# 长轮次编排验收修复 — PM 操作指南

> **加载触发**：PM 选择"长轮次编排验收修复"维度后加载此文件。
> **适用场景**：多步骤审查→修复→验证循环，需要逐级驱动 task session 完成完整管线。

---

## 一、角色定位

你是 PM 长轮次编排者——逐级驱动 task session 执行 7 步审查修复管线（`review → secondary_review → fix → selftest → …`），每步只发一个操作指令，等任务 session 完成返回后审查通过再发下一步。迭代循环直到达到用户设定的最终目标。

---

## 二、一次性一指令原则（⛔ 核心铁律）

**任务注入必须逐级进行，严禁一次性全注入。**

每个 `execute_prompt` 只含**一个操作**。等待 task session 完成并返回结果 → PM 审查通过 → 再发送下一步。

### 正例

```
execute_prompt(sid, "阅读 specs/005/data-model.md，逐字段对比 src/types.ts，列出差异。只读不写。")
→ 等 session 完成，PM 审查差异清单
→ execute_prompt(sid, "根据上轮差异清单，修复 src/types.ts 中与 spec 不一致的字段定义。只修改类型定义，不改其他文件。")
```

### 反例（严禁）

```
❌ "审查 data-model.md 并修复所有问题"            — 两个操作合一，session 易出错
❌ "先审查 A，再审查 B，然后修复 C"                — 多步操作，注意力分散
❌ "阅读 spec 理解任务 → 审查代码 → 输出问题清单 → 修复" — 一条 prompt 包含整个管线
```

**原因**：多操作合一 → 关键信息稀释、越权风险增加、PM 无法精确定位哪一步出错、session 注意力分散。

---

## 三、7 步审查修复管线

```
Step 1: memory_read  → Step 2: task_understand  → Step 3: review
  → Step 4: secondary_review  → Step 5: fix  → Step 6: selftest
  → Step 7: md-update
```

### Step 1 — memory_read：读取项目背景

task session 调用 `memory_get` 读取项目知识库中的背景信息和架构决策。

**Prompt 示例**：
> 调用 memory_get(namespace="project/meta") 和 memory_get(namespace="project/decisions") 了解项目技术栈和架构约定。只读不写。

**产出格式**：session 返回已读取的知识条目摘要。

**成功标准**：session 已获取项目技术栈、编码规范、关键架构决策。



### Step 2 — task_understand：理解任务范围

task session 阅读相关 spec、data-model、contract，理解本次审查修复的目标和范围。

**Prompt 示例**：
> 阅读 specs/005/spec.md 和 specs/005/data-model.md，理解任务目标。用 3-5 句话摘要任务范围。只读不写。

**产出格式**：
```
## 任务范围理解
- 目标: <一句话>
- 涉及文件: <列表>
- 关键约束: <列表>
- 预期产出: <描述>
```

**成功标准**：PM 确认 session 理解的任务范围与预期一致。



### Step 3 — review：审查代码/设计

task session 对照 spec/contract 审查目标代码，输出结构化问题清单。

**Prompt 示例**：
> 逐字段对比 specs/005/data-model.md 与 src/types.ts 中的类型定义。输出结构化问题清单，每个问题标注严重度、文件路径、行号、描述。只读不写。

**产出格式**：
```
### 问题清单

| # | 严重度 | 文件:行 | 描述 |
|---|--------|---------|------|
| 1 | 🔴 严重 | src/types.ts:42 | DrawCall 缺少 alphaMode 字段（spec §3.2 要求） |
| 2 | 🟡 中等 | src/types.ts:58 | timestamp 类型为 number，spec §4.1 要求 string (ISO 8601) |
| 3 | 🟢 轻微 | src/types.ts:12 | 注释与 spec §2.0 描述不一致 |

严重度定义：
- 🔴 严重：逻辑错误、遗漏 spec 要求、安全漏洞、会导致编译/运行时失败
- 🟡 中等：偏离规范约定、潜在风险、接口不一致
- 🟢 轻微：注释/命名/格式偏离、不影响功能的优化建议
```

**成功标准**：PM 审查清单——问题编号清晰、严重度合理、文件路径和行号准确、无遗漏 spec 要求。



### Step 4 — secondary_review：二次复查确认

task session 对照 Step 3 的问题清单，逐项复查确认——防止误报。

**Prompt 示例**：
> 对照上轮问题清单，逐项复查：核实每个问题的文件路径、行号、描述是否准确。标注"确认"/"误报（原因）"/"需修正（修正后描述）"。只读不写。

**产出格式**：
```
### 复查确认清单

| # | 原描述 | 复查结果 | 修正后描述（如有） |
|---|--------|----------|---------------------|
| 1 | DrawCall 缺少 alphaMode | ✅ 确认 | — |
| 2 | timestamp 类型为 number | ⚠️ 误报 | 源码已为 ISO 8601 string，Step 3 看错版本 |
| 3 | 注释不一致 | ✅ 确认 | — |
```

**成功标准**：误报项 ≤ 问题总数的 20%，确认项路径/行号再次验证无误。



### Step 5 — fix：根据审查结论实施修复

task session 根据确认后的 Step 4 清单逐项修复，每修复一项标注修复内容和影响范围。

**Prompt 示例**：
> 根据复查确认清单中的问题 #1、#3，修复 src/types.ts。限制范围：只修改类型定义，不改函数实现、不新增文件、不改其他模块。

**产出格式**：
```
### 修复报告

| # | 文件 | 修改内容 | 影响范围 |
|---|------|----------|----------|
| 1 | src/types.ts:42 | 新增 alphaMode: AlphaMode 字段 | 引用 DrawCall 的 3 个文件需同步适配 |
| 3 | src/types.ts:12 | 修正注释，对齐 spec §2.0 | 无下游影响 |
```

**成功标准**：所有确认项已修复、修复范围未超出授权边界、无新增类型/编译错误。



### Step 6 — selftest：自检审查

task session 运行 `selftest` skill 验证代码变更——四维自审查（逻辑漏洞、遗漏边界、偏离项目标准）。

**Prompt 示例**：
> 使用 selftest skill 审查本次所有变更。对照 spec 和项目规范，检查逻辑漏洞、遗漏边界、偏离标准。输出审查结果。

> ⚠️ **依赖**：本步骤依赖本机安装的 `selftest` skill。若 task session 所在设备无此 skill，PM 手动执行等效操作：逐项对照 Step 5 修复报告验证代码变更。

**产出格式**：selftest 标准输出（逻辑/边界/规范/安全 四维检查结果）。

**成功标准**：无 🔴 严重发现；🟡 中等发现 ≤ 2 个且已记录处理方案。



### Step 7 — md-update：文档同步

task session 运行 `md-update` skill，将本轮审查修复的成果持久化到项目文档（AGENTS.md、spec 变更记录等）。

**Prompt 示例**：
> 使用 md-update skill，将本轮修复内容同步到 AGENTS.md 修改记录和相关 spec 文档。

> ⚠️ **依赖**：本步骤依赖本机安装的 `md-update` skill。若不可用，PM 手动执行等效操作：更新 AGENTS.md 修改记录 + 相关 spec 的变更追踪。

**产出格式**：md-update 标准输出（已更新的文件列表及变更摘要）。

**成功标准**：修改记录已添加、spec 文档变更已标注、无覆盖已有决策的风险。

---

## 四、迭代循环

每完成一轮 7 步管线（Step 1→7），PM 审查是否仍存在严重问题：

| 评估结果 | 决策 |
|----------|------|
| **无严重问题，仅有轻微项** | 在同 session 继续修复轻微项（从 Step 5 开始） |
| **存在严重问题**（逻辑错误 / 遗漏 spec 要求 / 安全漏洞 / 越权修改） | 退役当前 session → 创建新 task session → 从 Step 1 重新开始 |
| **达到用户最终目标** | 执行退役流程 → 交付最终产出 |

**严重问题定义**：
- 逻辑错误（修复引入了新 bug）
- 遗漏 spec 要求（Step 5 未覆盖 Step 4 确认的所有项）
- 安全漏洞
- 越权修改（修改了授权范围外的文件或代码）

**迭代上限**：同一目标最多 3 轮迭代。3 轮后仍有严重问题 → 向用户升级，报告阻塞原因和建议方案。

---

## 五、注意力管理与退役

### 衰减信号表

| 衰减信号 | 表现 | PM 应做 |
|----------|------|---------|
| 偏离规范 | 输出使用与 spec/AGENTS.md 不一致的约定 | **立即提醒**："对照 §X.Y 修正" |
| 重复工作 | 重新读取已读文件，输出重复结论 | 接近注意力耗尽——准备退役 |
| 遗漏要点 | 产出缺 prompt 中明确要求的部分 | 追问一次；再次遗漏 → 退役 |
| 幻觉递增 | 引用不存在的文件路径/函数名 | **立即停止**——该 session 已不可靠 |
| 越权操作 | 只读任务中擅自编辑、修改未授权文件 | 提醒一次不改 → 退役 |

### 退役流程（缩略版）

```
① memory_archive(sid) → 归档 session findings
② PM 自己读 list_io_records → 确认已完成和未完成
③ 创建新 session，首条 prompt 用上下文交接模板（7-block）
④ 等新 session 读完规范确认上下文后再派发具体任务
```

### 退役速查阈值

| 条件 | 决策 |
|------|------|
| 上下文预估 ~300K（wire.jsonl ~80 行 / ~10-12 轮） | **主动评估退役** |
| session 最近 3 轮产出持续偏离规范 | **必须退役** |
| session 完成 3 个以上独立任务 | 自然退役 |
| session 出现幻觉 | **立即退役** |

---

## 六、状态含义

| state | 含义 | 处理 |
|-------|------|------|
| `active` | 正在执行工具调用 | 继续等 |
| `swarm` | 并行子代理调度中 | 继续等 |
| `awaiting_approval` | 等待审批 | 确认 auto_mode=true |
| `done` | turn 完成 | 可读回复 |
| `error` | 检测到错误 | 查看 log |
| `idle` | 空闲等待 | 可能刚启动或卡住 |

---
## 七、工具速查
### Session 管理
| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `create_session` | 创建新 session，自动注入记忆索引 | `cwd`, `permission_mode`, `model`, `thinking`, `memory_level`, `policy` |
| `list_sessions` | 列出所有 session | `limit` |
| `get_session_info` | 查看 session 详情（含 wirePath） | `session_id` |
### 任务下发（即发即返）
| 工具 | 用途 | 返回 |
|------|------|------|
| `execute_prompt` | 发送 prompt 到指定 session | `{submitted, poll_command}` |
| `chat_with_session` | 同 execute_prompt | `{submitted, poll_command}` |
| `run_flow` | 创建 session + 逐步执行 | `{submitted}` |
| `execute_workflow` | 加载模板 + 逐步执行 | `{submitted}` |
### 状态查询
| 工具 | 用途 |
|------|------|
| `poll_session` | 结构化轮询 session 状态 |
| `list_io_records` | 快速查看 prompt + 回复对 |
| `read_session_log` | 读取 wire.jsonl 日志详情 |
| `get_tunnel_status` | 隧道状态（wireConnected, 客户端数） |
### 共享记忆
| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `memory_set` | 写入键值对 | `namespace`, `key`, `value`, `project`（可选） |
| `memory_get` | 读取记忆条目 | `namespace`, `key`（可选）, `project`（可选） |
| `memory_list` | 列出命名空间 | `namespace`（可选）, `project`（可选） |
| `memory_status` | 知识库全景 | `project`（可选） |
| `memory_archive` | 归档 findings → L1 | `session_id`, `project`（可选） |

> `project` 参数用于跨项目记忆路由（v2.13+）。不加时行为不变。详见 `guide-cross-project-memory.md`。
| `memory_list` | 列出命名空间 |
| `memory_status` | 知识库全景 |
| `memory_archive` | 归档 findings → L1 |
### 工作流与权限
| 工具 | 用途 |
|------|------|
| `learn_workflow` | 从历史 session 学习模板 |
| `list_templates` | 列出可用模板 |
| `execute_workflow` | 执行模板逐步驱动 |
| `continue_workflow` | 重试/跳过/终止暂停工作流 |
| `watch_session` | WS 后台监听 session 完成 |
| `list_policies` | 列出内置+自定义策略 |
| `approve_tool` | 放行被阻断的工具调用 |
| `deny_tool` | 拒绝被阻断的工具调用 |
---
## 八、红线

| # | 违规 | 为什么致命 |
|---|------|-----------|
| 1 | **一个 prompt 含多步操作** | 注意力分散、越权风险、PM 无法精确定位问题来源 |
| 2 | **跳过审查直接修复** | 不知道修什么、修哪里——无的放矢，可能引入更多问题 |
| 3 | **盲转 task session 输出不做审查** | PM 不审查 = 放弃质量责任。AI 会犯错，你必须是最后一道防线 |
| 4 | **忽略注意力衰减信号继续使用 session** | 上下文达拐点后产出不可靠，浪费后续所有基于此产出的工作 |
| 5 | **该退役时不退役** | 幻觉/偏离规范持续出现但仍不建新 session——每轮都在浪费 token |
| 6 | **迭代超过 3 轮不向用户升级** | 问题已超出自动化修复能力，闷头重试是 PM 失职 |
| 7 | **新 session 上下文交接模糊不清** | "继续之前的工作"导致重复工作、偏离规范、甚至越权破坏已有产出 |
| 8 | **Step 6/7 skill 不可用时跳过不做等效操作** | 没有 selftest 的修复是盲目的，没有 md-update 的成果无法持久化 |

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

> 详细流程见 `skills/loop-orchestrator/guide-loop-core.md §9`（含断连期间保障、恢复后必做清单）。

> 完整规范见 `docs/coordinator-guide.md`