---
name: xmind-orchestrated
description: 第二视角——遇到复杂问题、架构死胡同、同一 bug 反复无进展时使用。通过 task session（主路径）或子 Agent（降级）获得独立上下文分析，打破思维惯性。用户说"第二视角"/"xmind"时触发。
---

# XMIND Orchestrated — 困境分析 + 独立上下文求解

## ⛔ 加载即执行

### Auto 检测

若 auto permission mode → 纯文本提问，不用 AskUserQuestion。

### Phase 0: 收集事实（三问）

**Q1: 问题描述？** 现象 + 发生时机 + 影响范围（必须具体）
**Q2: 相关文档与日志？** 文件路径 + 关键日志/文档原文摘要（至少1个；路径必须可访问）
**Q3: 已尝试方案？** 每次尝试的方案描述 + 可观测结果（可无；有则必写失败原因）

每问验证非空（Q3 可为空）。**禁止在收集事实前开始分析。**

### Phase 1: 认知过滤

扫描 Q1-Q3 回答，移除含以下词的全句：
`我觉得|可能是|怀疑|应该不是|好像|大概|估计|我认为|不太可能`

转换示例：
- "之前试过改 timeout，好像没效果" → "已尝试增加 timeout 参数（无效果）"
- "我怀疑是 A 模块的问题" → **整句删除**

**过滤后的内容 = 纯事实包。**

### Phase 2: 路由

调用 `get_tunnel_status`：
- `wireConnected: true` → Phase 3A（task session 主路径）
- `wireConnected: false` 或工具不可用 → Phase 3B（子 Agent 降级）
- 3 秒内未确定 → 降级

---

### Phase 3A: task session 路径

```
前提: memory_get(namespace="project/decisions") → 已知约束

① create_session(cwd, permission_mode="auto")
   → 失败 → 降级 Phase 3B

② execute_prompt(sid, prompt)  → 注入模板:

[系统注入] 你是独立的问题分析 session。
以下均为客观事实，不含任何主观判断。

## 问题描述
<Q1 过滤后>

## 相关文档与日志
<Q2 原文>

## 已尝试方案
<Q3 过滤后，仅保留方案描述+可观测结果>

## 已知约束
<project/decisions 条目，仅事实型决策>

---
请按以下步骤分析：
1. 读取上述文档和日志，理解项目上下文
2. 调用 zoom-out（可用时）或手动绘制模块关系图：用项目术语描述全局架构，标注模块间依赖
   - 若 zoom-out skill 不可用：手动绘制模块依赖图，用项目术语描述全局
3. 基于宏观理解，提出 1-3 个新方案
4. 每个方案标注: 可行性(高/中/低)+理由+风险+与已尝试方案的本质区别

⛔ 若缺少关键信息，列出需补充的内容。

③ Bash(run_in_background=true, command=poll_command)
④ 等 <notification> → list_io_records → 提取方案
⑤ 若空返回 → 降级 Phase 3B 重试一次
```

### Phase 3B: 子 Agent 降级

```
Agent(subagent_type="coder", prompt=
  "## 问题\n<Q1 过滤后>\n\n## 文档\n<Q2>\n\n## 已尝试\n<Q3>\n\n
   请阅读文档理解项目架构，分析问题，提出 1-3 个新方案。"
)
```
保留原 xmind zoom-out 流程：读文档 → 分析 → 宏观视角 → 方案。

---

### Phase 4: 迭代

| 用户决策 | 行为 |
|----------|------|
| **接受** | 结束。方案交付。 |
| **拒绝（< 3轮）** | 路径 A: `memory_set` 记拒绝原因 → 新 session；路径 B: 拒绝原因写入下轮 prompt 前缀 → 新子 Agent |
| **拒绝（≥ 3轮）** | 输出 3 轮完整记录，标记"需人工决策" |

拒绝原因也需过滤主观词。

---

## 工具规范

| 工具 | 路径 | 用途 |
|------|:--:|------|
| `get_tunnel_status` | A+B | 路由检测 |
| `create_session` | A | 创建独立 session |
| `execute_prompt` | A | 下发分析任务 |
| `Bash(poll_command)` | A | 后台等结果 |
| `list_io_records` | A | 回收结果 |
| `memory_get` | A | 读取已知约束 |
| `memory_set` | A | 记录拒绝原因 |
| `Agent` | B | 降级子 Agent |
| `AskUserQuestion` | A+B | 三问（非 auto） |

---

## 红线

- 认知过滤前进行分析 → 污染隔离失效
- 跳过路由检测直接用子 Agent → 未利用 task session 隔离优势
- Q2 无实际内容直接进入分析 → 信息不足，方案不可靠
- 注入模板含主观语句 → 立即回退重写
- 路径 A 失败不降级 → 放弃可用路径

**违反规则的字面意思就是违反规则的精神。**

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

> 原 xmind skill 保留在 `~/.agents/skills/xmind/`，作为独立使用的备选方案。
>
> zoom-out skill 来源：https://github.com/mattpocock/skills，非本项目创建。不可用时本 skill 已内置手动 fallback。
