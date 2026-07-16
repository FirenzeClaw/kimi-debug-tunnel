# 执行者指南

> 你是执行者，不是 PM——当前 session 自己干活，仅用 tunnel 工具做后台编排辅助。

## 标准工作流

```
① create_session(cwd="/path", permission_mode="auto")
   → { session_id }

② execute_prompt(session_id, "任务描述", auto_mode=true)
   → { submitted: true, poll_command: "..." }

③ Bash(run_in_background=true, command=poll_command)
   → 后台轮询，完成时 <notification> 自动通知

④ 等待通知 → 读取 output.log → 拿到回复
```

> ⛔ **poll_command 必须原样使用，禁止手写改写。** `execute_prompt` 返回的 `poll_command` 已正确格式化（v2.8.4）：`fetch_result` 用 Python `urllib.request` 直连 HTTP（无 curl 管道截断）+ `PYTHONIOENCODING=utf-8`。直接传给 Bash，一字不改。

## 核心铁律

| 规则 | 违反后果 |
|------|----------|
| 即发即返，不阻塞 | MCP 超时截断，任务 session 仍在跑但你拿不到结果 |
| 后台 Bash 轮询 | OS 进程信号驱动，零 token 等待，完成时自动通知 |
| 不用 `wait=true` | 已废弃，受 MCP 超时限制 |
| 不在同一 turn 反复 poll | 浪费 token，session 未完成时空等 |

## 工具速查

**Session 管理** `create_session` `list_sessions` `get_session_info` `get_tunnel_status`
**任务下发** `execute_prompt` `chat_with_session` `run_flow`
**状态查询** `poll_session` `list_io_records` `read_session_log`

## 状态含义

| state | 含义 | 处理 |
|-------|------|------|
| `active` | 正在执行工具调用 | 继续等 |
| `swarm` | 并行子代理调度中 | 继续等 |
| `awaiting_approval` | 等待审批 | 检查 auto_mode |
| `done` | turn 完成 (end_turn) | 读取回复 |
| `error` | 检测到错误 | 查看 log |
| `idle` | 空闲 | 可能刚启动或卡住 |

## 红线

- "我手动轮询几次看看" → 启动后台 Bash 任务
- "这次简单，阻塞等也没事" → MCP 超时 30s，必截断
- "用 wait=true 更方便" → 已废弃，始终即发即返
- "直接把 poll_command 改一下" → 工具已生成正确命令（v2.8.4 urllib 直连 + UTF-8），不要修改

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

> 关键约束（不重复 poll、一 bash 一 session、auto_mode 规则等）见 SKILL.md。
> 完整规范见 docs/coordinator-guide.md
