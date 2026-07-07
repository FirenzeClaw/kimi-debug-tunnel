# 统筹 Session 准入规范

> 面向使用 kimi-debug-tunnel MCP 工具的 AI 统筹 Session。
> 定义每条工具的准入条件、推荐使用模式、以及统筹 Session 自身的运行规范。

---

## 一、工具准入矩阵

### 1.1 Session 生命周期

| 工具 | 准入条件 | 禁止使用场景 |
|------|----------|-------------|
| `create_session` | 需要新开独立任务 session；知道目标工作目录 `cwd` | 复用已有 session 即可（用 `list_sessions` 找）；不知道 `cwd` |
| `list_sessions` | 需要查看所有可用 session 或定位某个 session ID | 已经持有目标 session_id（直接用 `get_session_info`） |
| `get_session_info` | 需要查看 session 标题、工作目录、wirePath、创建时间 | session_id 未知（先用 `list_sessions`） |

### 1.2 任务下发

| 工具 | 准入条件 | 禁止使用场景 |
|------|----------|-------------|
| `execute_prompt` | 向已有 session 发送单条 prompt；已知 `session_id` | 需要多步编排（用 `run_flow` 或 `execute_workflow`） |
| `chat_with_session` | 同 `execute_prompt`，别名 | 同上 |
| `run_flow` | 多步顺序任务；已知 `cwd` 和所有步骤 | 步骤间有分支/条件逻辑（用 `execute_workflow`） |
| `execute_workflow` | 已知模板名；模板已用 `learn_workflow` 创建 | 模板不存在（先用 `list_templates` 确认） |

**铁律**：所有任务下发工具 **即发即返**（`wait=false`），绝不阻塞统筹 turn。

### 1.3 状态查询

| 工具 | 准入条件 | 禁止使用场景 |
|------|----------|-------------|
| `poll_session` | 抽查 session 是否 idle/done/error；间隔 ≥ 10s | 高频轮询（用后台 Bash REST 轮询代替）；同一 turn 多次调用 |
| `list_io_records` | 快速查看对话摘要（prompt+回复，去噪音）；需要 `max_content_length` 控制长度 | 读取完整日志（用 `read_session_log`）；高频轮询 |
| `read_session_log` | 需要原始日志详情（含 tool_call、thinking、step_end）；需要增量读取（`after_line`） | 替代 `poll_session` 做状态查询 |

### 1.4 后台监听

| 工具 | 准入条件 | 禁止使用场景 |
|------|----------|-------------|
| `watch_session` | 启动 WS 驱动的后台监听；需要自动化循环（配合 `continue_watch`） | 手动轮询就能满足的场景 |
| `get_watch_result` | 已启动 `watch_session`，需要非阻塞获取结果 | 未启动监听 |
| `continue_watch` | 自动循环模式：拿结果 → 发下一步 → 启新监听 | 不需要自动循环的单次任务 |
| `set_watch_output` | 需要将结果写入文件供外部进程读取 | 常规任务——Bash 后台轮询更简单 |

### 1.5 工作流模板

| 工具 | 准入条件 | 禁止使用场景 |
|------|----------|-------------|
| `learn_workflow` | 有可复用的多步流程；有历史 session 作参考或口头描述 | 一次性任务 |
| `list_templates` | 需要确认可用模板或查模板详情 | 已知模板名直接执行 |
| `execute_workflow` | 模板已就绪；可接受 WebSocket 进度推送 | 模板未验证（先 `list_templates`） |
| `continue_workflow` | 工作流暂停在阻塞状态；需要决策（retry/skip/abort/manual） | 工作流正常运行中 |

### 1.6 辅助

| 工具 | 准入条件 | 禁止使用场景 |
|------|----------|-------------|
| `get_tunnel_status` | 怀疑隧道自身状态异常（Wire 断开、客户端异常） | 查询任务 session 状态（用 `poll_session`） |
| `stream_response` | 需要向 WebSocket 调试客户端推送实时内容 | 向任务 session 发送指令（用 `execute_prompt`） |

---

## 二、统筹 Session 运行规范

### 2.1 黄金法则

```
提交 → 后台轮询 → 收到通知 → 读取结果 → 继续
```

**绝不在同一个 turn 内**：
- 阻塞等待 `execute_prompt` 返回（`wait` 参数已废弃）
- 同步 `while` 循环轮询 session 状态
- 多次调用 `poll_session` / `list_io_records` 手动检查

### 2.2 推荐流程：Bash 后台 REST 轮询

```bash
# ① 创建任务 session
create_session(cwd="/path/to/project", permission_mode="auto")
  → { session_id: "ses_xxx" }

# ② 提交 prompt（即发即返）
execute_prompt("ses_xxx", "你的任务描述", auto_mode=true)
  → { submitted: true, poll_command: "..." }

# ③ 启动后台 Bash 轮询（零 token 等待）
Bash(run_in_background=true, command=poll_command)
  → 后台进程由 OS 管理，session idle 时自动退出
  → runtime 注入 <notification> 到统筹 session

# ④ 收到通知后读取结果
list_io_records("ses_xxx", max_content_length=5000)
  → 获取任务 session 的完整回复
```

### 2.3 多 Session 并发

- 每个任务 session 分配一个独立的后台 Bash 轮询进程
- 所有后台进程并行启动，不等候彼此
- 收到某个 session 的 `<notification>` 后再读取其专属结果
- 不提前手动 `poll_session` —— 浪费 token

### 2.4 Session 生命周期管理

| 阶段 | 操作 | 备注 |
|------|------|------|
| 创建 | `create_session(cwd, permission_mode)` | `auto` 模式避免审批卡住 |
| 使用 | `execute_prompt(session_id, task, auto_mode=true)` | 每次 prompt 都传 `auto_mode` |
| 监控 | 后台 Bash 轮询 | 不占用当前 turn |
| 回收 | session 任务完成后，统筹记录结果 | 不手动关闭（session 由 kimi web 管理） |

### 2.5 错误处理

| 错误类型 | 现象 | 处理 |
|----------|------|------|
| **Hex escape** | Provider 返回 `400 unexpected end of hex escape` | 内容含反斜杠序列触发了 kimi-code 序列化 bug；已通过 `sanitizeText` 加固防御（v2.1+）；若仍触发，用 `max_content_length` 缩小返回内容 |
| **Session 忙碌** | `execute_prompt` 返回 "session is busy" | 等 5s 重试；仍失败则 `poll_session` 查看状态 |
| **Session 卡住** | 后台轮询超 5min 仍未 idle | 检查 `poll_session` 状态——`awaiting_approval` 注意 `auto_mode` 未生效；`active` 超时可能是死循环 |
| **Tunnel 断开** | `get_tunnel_status` 显示 Wire 未连接 | 检查 kimi web 是否运行；Token 是否过期；重启 tunnel |
| **内容截断** | `list_io_records` 返回 `...` | 增大 `max_content_length`（最大 50000）；或用 `read_session_log` 直接读 wire.jsonl |

### 2.6 内容安全规范

> 配合 `sanitizeText` 防御层（`session-log-reader.ts`），统筹 Session 输出内容经过以下处理：

| 清洗项 | 行为 | 原因 |
|--------|------|------|
| `\xNN` / `\uNNNN` | 双反斜杠预加固（幂等） | 防御 kimi-code JSON 序列化器漏转义 |
| Lone surrogates | → `\uFFFD` | 非法 Unicode，JSON 不兼容 |
| 控制字符 (0x00-0x1F) | → 空格（保留 `\t\n\r`） | JSON 不可见字符 |
| 长度截断 | `max_content_length` 默认 2000（`list_io_records`）/ 500（`read_session_log`） | 控制 token 消耗 |

**统筹 Session 自身的内容输出也应遵守**：
- 不内联超过 5KB 的工具输出原文
- 大段内容写文件 → 告知路径
- 对从任务 session 获取的内容做摘要后再传递

---

## 三、红线

| 违规 | 后果 |
|------|------|
| 在同一 turn 内多次调用 `poll_session` / `list_io_records` | 浪费 token，MCP 协议开销叠加 |
| `execute_prompt(wait=true)` | 阻塞当前 turn，MCP 30s 超时截断 |
| 不传 `auto_mode=true` 且不手动审批 | Session 卡在 `awaiting_approval` |
| 手动拼接 curl 命令替代 `poll_command` | 平台兼容性问题（Python 路径检测等） |
| 内容不截断直接传递 | 触发 hex escape 错误或 token 爆炸 |
| 用 `read_session_log` 做状态检测 | 应使用 `poll_session`——零 I/O WS 缓存 |

---

## 四、版本对应

| Tunnel 版本 | 关键变更 |
|-------------|----------|
| v2.1 | `sanitizeText` 反斜杠预加固 + 控制字符清洗；`max_content_length` 可配截断 |
| v2.0 | 自适应工作流引擎；即发即返模式；WS 状态缓存 |
| v1.x | 阻塞式 `wait` 模式（已废弃） |
