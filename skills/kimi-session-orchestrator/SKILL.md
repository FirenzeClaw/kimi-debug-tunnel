---
name: kimi-session-orchestrator
description: 当需要操作 kimi-session-orchestrator MCP 工具时使用
---

# Kimi Session Orchestrator — PM 视角多 session 编排

---

## ⛔ 加载即执行——启动协议

**此 skill 加载后，必须完成以下步骤再处理任何用户请求：**

### Auto 检测

如果当前 session 处于 auto permission mode（系统提示 `Auto permission mode is active`），AskUserQuestion 工具将不可用。

- **Auto 模式**：用纯文本提问，同时提示用户 `/auto` 可退出
  ```
  **Q1: 角色与维度？**
  A: PM 规划派发 / B: PM 长轮次编排 / C: 执行者
  （提示：输入 /auto 退出 auto 模式可获得交互式选项）
  ```
- **非 auto 模式**：使用 AskUserQuestion 工具，一次一个问题
- 禁止调用 ExitPlanMode——它与 auto permission 无关

### 第一轮：Q1 — 角色与维度

非 auto 模式用 AskUserQuestion，auto 模式用纯文本提问。选项：
- **A: PM 统筹 — 规划派发与验收** → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-planning.md`
- **B: PM 统筹 — 长轮次编排验收修复** → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-orchestration.md`
- **C: 执行者** → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-execute.md`

#### Q1b: 子项目路径分离确认（仅 Q1=A 或 B 时追问）

规划中心（当前目录）与开发项目在不同路径时，子项目有自己的 `.kimi-tunnel/memory.db`。v2.13 起支持双层记忆注入——全局决策自动传播 + 子项目规范独立存储。

非 auto 模式用 AskUserQuestion，auto 模式用纯文本提问：
- **是，分离**：子项目在独立路径，需读其 `.kimi-tunnel/memory.db` → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-cross-project-memory.md`
- **否**：所有工作在同一项目下，使用默认单层记忆注入

> Q1b 跳过情况：若用户任务不涉及创建子 session（如纯审查、纯问答），可跳过追问。

### 第二轮：Q2 — 目标与追问

#### Q2a: 最终目标？（通用）
自由文本。示例："审查 specs/003 的全部实现，修复发现的 bug，输出审查报告"

#### Q2b: 派发模式？（仅 Q1=A 时追问）
- **纯派发验收**：PM 拆解 → 派发 task session 执行 → PM 对照规范验收
- **派发+自审**：PM 拆解 → 派发 task session 执行 → session 自审查修复 → PM 验收

### 第三轮：Q3 — 决策模式
- **自主执行**：阻塞自判（重试/跳过/降级），结果交付时汇报
- **关键点等待**：拆解后、审查后、异常时暂停等用户指示

### 运行模式设定

根据 Q1+Q3 组合设定行为：
- PM+自主：自主完成 理解→拆解→编排→收集→合成 全流程
- PM+关键点：每阶段暂停展示进度
- 执行者+任意：不使用 PM 决策框架，仅工具操作辅助

---

## 核心铁律

> 提交 prompt 后，必须 `Bash(run_in_background=true)` 后台轮询，绝不阻塞。

| 规则 | 违反后果 |
|------|----------|
| 即发即返，不阻塞 | MCP 超时截断 |
| 后台 Bash 轮询 | 零 token 等待，自动通知 |
| 不用 `wait=true` | 已废弃 |
| 不重复 poll | 浪费 token |

## 关键约束

1. **不要在同一 turn 内多次 poll** — 每次调用消耗 token，且 session 未完成时空等
2. **一个后台 bash 任务只轮询一个 session** — 多 session 用多个后台任务
3. **收到通知后再读 output.log** — 不要提前 TaskOutput
4. **auto_mode=true 时不需要手动审批** — 工具调用自动通过
5. **create_session 的 permission_mode="auto" 是 session 级别** — 后续 prompt 也需 auto_mode=true

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
