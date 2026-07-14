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

> ⛔ **poll_command 必须原样使用，禁止手写改写。** `execute_prompt` 返回的 `poll_command` 已正确格式化——Python `-c` 使用真正的多行字符串。**手写时若在 bash 双引号内用 `\n` 代替换行，`\n` 不会被展开**，Python 收到非法 token 触发 `SyntaxError`，被 `2>/dev/null` 静默吞掉 → 输出永远为空。直接传给 Bash，一字不改。

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
- "直接把 poll_command 改一下" → 手写时 bash 双引号 `\n` 不展开 → Python SyntaxError → `2>/dev/null` 静默吞错 → 输出永远为空。不要修改，工具已生成正确命令

> 关键约束（不重复 poll、一 bash 一 session、auto_mode 规则等）见 SKILL.md。
> 完整规范见 docs/coordinator-guide.md
