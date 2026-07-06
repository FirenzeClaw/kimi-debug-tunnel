---
name: agent-session-monitor
description: 当需要检测 Agent 会话是正常运行、卡住、等待审批还是已完成时使用——通过解析 wire protocol 日志尾部的状态机判断，不依赖 API（API 可能需认证或不可用）
---

# Agent 会话状态监控

## 概述

监控远程 Agent 会话的实时状态。通过解析会话日志（wire.jsonl）的最近几行来推断状态机，而非调用需要认证的 API。核心是**从日志尾部条目类型推断会话状态**。

## 何时使用

- 编排工具提交任务后需要跟踪进度
- 需要区分"正常运行"和"卡住无响应"
- 需要检测 `awaiting_approval` 状态（自动化审批失败时）
- 目标环境的 API 不可用或需要认证
- 需要低成本轮询（仅读文件，无 HTTP 开销）

## 核心模式：日志尾部状态机

### 输入

读取 wire.jsonl 最后 10-15 行，按条目类型分类：

```
tail -15 wire.jsonl
```

### 状态推断规则

| 检测到的模式 | 状态 | 含义 |
|-------------|------|------|
| 最近行含 `tool.call` | `active` | 🟢 正常执行中 |
| 最近行含 `swarm` 且无 tool_call | `swarm` | 🟢 并行子代理调度 |
| 最近行含 `awaiting_approval` 且无 tool_call | `awaiting_approval` | 🟡 等待工具审批 |
| 最后一行 `step.end` + `finishReason: end_turn` | `done` | ✅ 回合完成 |
| 最近行含 `error` | `error` | 🔴 发生错误 |
| 以上都不匹配 | `idle` | ⏳ 空闲/等待中 |

### 优先级

`awaiting_approval` > `done` > `swarm` > `active` > `error` > `idle`

审批卡住是最紧急的信号，即使有其他活动也要优先报告。

### 输出结构

```typescript
interface SessionStatus {
  sessionId: string;
  state: "active" | "swarm" | "awaiting_approval" | "done" | "error" | "idle";
  stateLabel: string;          // 人类可读标签
  totalLines: number;          // 日志总行数
  lastTurn: number;            // 当前轮次
  toolCallsInTurn: number;     // 当前轮次工具调用数
  complete: boolean;           // state === "done"
  alerts: string[];            // 告警列表
}
```

## 进度检测

### 行数变化 = 活跃信号

连续两次轮询对比 `totalLines`：
- **增长** → 有活动，重置停滞计数器
- **不变** → 累积停滞时间

停滞阈值建议 **60 秒**（10 次 × 6 秒间隔）。超过阈值但状态非 `done` → 告警"可能卡住"。

### 停滞检测实现

```typescript
let lastLines = 0;
let stallSeconds = 0;

function checkProgress(status: SessionStatus): void {
  if (status.totalLines > lastLines) {
    stallSeconds = 0;        // 有进展，重置
  } else {
    stallSeconds += POLL_INTERVAL;
  }
  lastLines = status.totalLines;

  if (stallSeconds >= 60 && !status.complete) {
    status.alerts.push(`${stallSeconds}s 无进度——session 可能卡住`);
  }
}
```

## 完整轮询循环

```
while (true) {
  status = pollSessionStatus(sessionId);
  show(status.stateLabel, status.totalLines, status.alerts);

  if (status.state === "awaiting_approval")
    → warn("auto_mode 可能未生效");

  if (status.state === "done")
    → break;  // 完成

  if (stallSeconds >= 60 && !status.complete)
    → warn("可能卡住");

  sleep(6);
}
```

## 实现参考

完整实现参考 [`kimi-debug-tunnel`](https://github.com/FirenzeClaw/kimi-debug-tunnel)：

| 组件 | 文件 | 职责 |
|------|------|------|
| 状态提取 | `session-log-reader.ts` → `pollSessionStatus()` | 解析 wire.jsonl 尾部，返回结构化状态 |
| 工具暴露 | `tools/poll-session.ts` | MCP 工具封装，含 stateLabel 映射 |
| 进度轮询 | `tools/list-io-records.ts` | 快速提取 prompt + 回复对 |

## 常见错误

| 错误 | 修复 |
|------|------|
| 仅检查 end_turn 判断完成 | 还需检测 awaiting_approval（卡住信号）和 error |
| 调用需认证的 API 做状态检测 | 直接从 wire.jsonl 尾部推断，零认证开销 |
| 一次 poll 就判断"卡住" | 至少连续 60s 无行数变化才告警 |
| 状态标签用英文 | 提供 `stateLabel` 中文映射，方便人类阅读 |
