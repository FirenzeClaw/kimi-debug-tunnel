# Poll Command 预置脚本 + 降级回调

> 日期: 2026-07-16 | 状态: design

## 背景

v2.15 将 `poll_command` 改为纯 `python -c` 内联脚本，工作正常，但仍有两个改进空间：

1. **token 浪费**：每次返回 ~4KB 内联 Python 代码，其中 95% 是静态逻辑
2. **冗余传输**：PM 统筹 session 接收完整脚本后再次 bash 转发

## 目标

`execute_prompt` / `chat_with_session` 调用时自动将 Python 脚本持久化到 `~/.kimi-tunnel/poll.py`，后续调用直接引用该文件。写入失败时无缝降级为内联脚本，不影响编排流程。

## 设计

### 架构

```
execute_prompt() 调用
  │
  ├─ try: ensureDir + writeFile(~/.kimi-tunnel/poll.py, POLL_SCRIPT)
  │    ├─ 成功 → 返回短命令: python3 ~/.kimi-tunnel/poll.py <args>
  │    └─ 失败（权限/磁盘/NFS）→ 返回内联: python3 -c "POLL_SCRIPT" <args>
  │
  └─ PM Bash(run_in_background=true) 执行
       两种路径 PM 都能立即继续，降级零阻塞
```

### 改动点

| 文件 | 改动 |
|------|------|
| `src/poll-command.ts` | 新增 `export const POLL_SCRIPT` 模块级常量（剥离自 `generatePollCommand` 的 py 数组）；`generatePollCommand()` 加入 `existsSync` 判断分支 |
| `src/tools/execute-prompt.ts` | 调用 `generatePollCommand` 前执行 `writeFile` + `ensureDir`；降级时返回 `degraded: true` |
| `src/tools/chat-with-session.ts` | 同上 |

### 返回差异

**正常（poll.py 存在）：**

```json
{
  "submitted": true,
  "session_id": "ses_xxx",
  "poll_command": "PYTHONIOENCODING=utf-8 python3 ~/.kimi-tunnel/poll.py ses_xxx http://127.0.0.1:58627 token123 300 3"
}
```

**降级（写入失败）：**

```json
{
  "submitted": true,
  "session_id": "ses_xxx",
  "poll_command": "PYTHONIOENCODING=utf-8 python3 -c \"...完整内联脚本...\" ses_xxx http://127.0.0.1:58627 token123 300 3",
  "degraded": true,
  "hint": "prompt 已提交。~/.kimi-tunnel/ 写入失败已降级。检查目录权限，或手动 mkdir ~/.kimi-tunnel 后重试即可启用记忆脚本。"
}
```

### 并行安全

首次多 session 并发调用时，多个 `execute_prompt` 同时 try-write 同一文件。`writeFileSync` 是原子操作，文件内容为常量 `POLL_SCRIPT`，最后一个写入胜出，无竞态危害。

### 不变项

- `generatePollCommand()` 函数签名不变
- `PollConfig` 接口不变
- 退出码协议 0/2/3/4 不变
- 后台 task 挂载方式不变（`Bash(run_in_background=true)`）
- 降级时行为与 v2.15 完全一致

## 自检

| 检查项 | 状态 |
|--------|------|
| 占位符/TODO | 无 |
| 范围聚焦 | 3 文件（poll-command + execute-prompt + chat-with-session），无新依赖 |
| 模糊性 | 降级路径明确，不阻塞 PM |
| 向后兼容 | `degraded` 字段新增，旧版本 PM 忽略该字段即可 |
| 并行安全 | `writeFileSync` 原子写入 + 内容常量 = 无竞态 |
