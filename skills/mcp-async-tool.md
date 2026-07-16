---
name: mcp-async-tool
description: 当 MCP 工具需要触发耗时超过 30 秒的 Agent 任务（代码生成、多轮编排、批量处理）时使用——解决 MCP 协议超时导致工具调用失败的问题
---

# MCP 异步工具模式

## 概述

MCP 协议有隐式超时（~30s），但 Agent 任务常需数分钟。**不要阻塞等待——提交后立刻返回，通过独立轮询工具跟踪进度。**

核心原则：**即发即返（fire-and-forget），轮询分离（poll separation）。**

## 何时使用

- MCP 工具触发 Agent 会话中的长时间任务（>15s）
- 需要在工具调用后继续跟踪任务进度
- 多轮编排场景，每轮都可能超时
- 需要知道任务是"运行中"还是"已完成"还是"卡住"

## 核心模式

### 工具侧：提交 + 返回

每个耗时工具提供 `wait` 参数，默认 `false`：

```typescript
server.tool("long_task", "...", {
  wait: z.boolean().default(false).describe("默认 false（即发即返）"),
}, async ({ wait, ... }) => {
  if (!wait) {
    // 快通道：仅提交，立即返回
    const { taskId } = await submitTask(input);
    return { submitted: true, task_id: taskId };
  }
  // 慢通道：阻塞等待（仅用于简单/快速场景）
  const result = await runAndWait(input);
  return result;
});
```

### 传输层：拆分 submit 和 poll

```typescript
class Client {
  // 仅提交，不轮询
  async submitTask(input): Promise<{ taskId: string }> { ... }

  // 提交 + 轮询直到完成（内部调用 submit + loop）
  async runAndWait(input, options): Promise<Result> { ... }
}
```

### 调用方：提交 → 后台轮询 → 通知

**推荐**：用操作系统后台进程轮询，而非 MCP 工具轮询（零 token 等待）：

```
Step 1: long_task(wait=false)
  → { submitted: true, task_id: "...", poll_command: "..." }

Step 2: Bash(run_in_background=true, command=poll_command)
  → 后台 Python 进程 urllib 轮询，完成时自动通知

Step 3: <notification> 到达 → Read ~/.kimi-tunnel/poll-result-{sid}.txt → 拿到结果
  （或读取通知中的 output.log 路径）
```

**备选**：MCP 轮询工具（轻量场景）：
```
Step 1: long_task(wait=false) → { submitted: true }
Step 2: poll_task(task_id)     → { state: "active" }
Step 3: poll_task(task_id)     → { state: "done", result: "..." }
```

## 轮询工具设计

轮询工具必须返回**结构化状态**，调用方可据此决策：

```typescript
interface PollResult {
  state: "active" | "done" | "error" | "awaiting_input";
  progress?: number;        // 0-100
  alerts: string[];         // 告警信息
  complete: boolean;        // 快捷判断
}
```

关键字段：
- `state` — 状态机，调用方据此分支
- `alerts` — 人类可读的告警（"卡住了"、"等待审批"）
- `complete` — 布尔值，调用方可快速退出轮询循环

## 实现参考

完整实现参考 [`kimi-session-orchestrator`](https://github.com/FirenzeClaw/kimi-session-orchestrator)：

| 组件 | 文件 | 模式 |
|------|------|------|
| 提交快通道 | `wire-client.ts` → `submitPrompt()` | 仅 POST，返回 prompt_id |
| 慢通道 | `wire-client.ts` → `sendPrompt()` | submit + 等待直到 idle |
| 工具层 | `tools/execute-prompt.ts` | `wait=false` 即发即返 + 返回 `poll_command` |
| 轮询工具 | `tools/poll-session.ts` | 结构化状态（WS 缓存优先） |
| 后台轮询 | `poll-command.ts` → `generatePollCommand()` | 生成纯 Python 内联轮询脚本；预置脚本存在时返回短命令 `python3 ~/.kimi-tunnel/poll.py <args>` |
| 使用规范 | skill: `kimi-session-orchestrator` | 完整 MCP 工具使用规则 |

## 常见错误

| 错误 | 修复 |
|------|------|
| 工具内 `await` 耗时操作导致超时 | 拆分为 submit（返回）+ 后台 bash 轮询 |
| 轮询工具只返回原始数据 | 返回结构化状态 + `alerts` + `complete` |
| `wait` 默认 `true` | 默认 `false`，即发即返 |
| 超时后认为任务失败 | 超时只说明等待超时，任务可能仍在运行——提示用户用轮询工具检查 |
| 在同一 turn 内反复调用轮询工具 | 用 `Bash(run_in_background=true)` 后台轮询，零 token 等待 |
| 手动拼接轮询命令 | 工具返回的 `poll_command` 已包含完整 Python 脚本（v2.16 起支持短命令 + 降级内联） |
