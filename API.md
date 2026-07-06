# Kimi Server API 完整参考

> 版本: 0.22.3 | 协议: REST + WebSocket | 提取自 kimi-openapi.json + asyncapi.json

---

## 通用约定

- **Base URL**: `http://127.0.0.1:5494`（默认，可通过 `--port` 修改）
- **认证**: `Authorization: Bearer <token>` header
- **响应信封**: 所有 REST 响应包裹在 `{ code: 0, msg: "ok", data: {...}, request_id: "..." }` 中
- **`code: 0`** = 成功，非 0 = 错误

---

## 一、REST API（51 个端点）

### 1.1 Meta — 服务器元信息

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/meta` | 获取服务器版本、capabilities、启动时间 |
| POST | `/api/v1/shutdown` | 优雅关闭服务器 |

**GET /meta 响应 data**:
```
server_version: string, capabilities: {websocket, file_upload, fs_query, mcp, background_tasks, terminal},
server_id: string, started_at, open_in_apps: ["finder"|"cursor"|"vscode"|"iterm"|"terminal"]
```

---

### 1.2 Auth — 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/auth` | 获取认证就绪状态（ready, providers_count, default_model） |
| POST | `/api/v1/oauth/login` | 启动 OAuth device-code flow |
| GET | `/api/v1/oauth/login?provider=` | 轮询 OAuth flow 状态 |
| DELETE | `/api/v1/oauth/login?provider=` | 取消 OAuth flow |
| POST | `/api/v1/oauth/logout` | 登出 OAuth provider |

---

### 1.3 Config — 全局配置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/config` | 获取全局配置（secrets 已脱敏） |
| POST | `/api/v1/config` | 更新配置（merge 语义） |

**配置项**: providers, default_provider, default_model, models, thinking, plan_mode, yolo, default_thinking, default_permission_mode, permission, hooks, services, merge_all_available_skills, extra_skill_dirs, loop_control, background, experimental, telemetry

---

### 1.4 Sessions — 会话管理

| 方法 | 路径 | 说明 |
|------|------|------|
| **POST** | `/api/v1/sessions` | **创建新 session** |
| GET | `/api/v1/sessions` | 列出 sessions（支持分页、状态过滤） |
| GET | `/api/v1/sessions/{id}` | 获取 session 详情 |
| GET | `/api/v1/sessions/{id}/profile` | 获取 session profile |
| POST | `/api/v1/sessions/{id}/profile` | 更新 profile（title, metadata, agent_config, permission_rules） |
| GET | `/api/v1/sessions/{id}/status` | **获取实时状态**（idle/running/awaiting_approval/awaiting_question/aborted） |
| GET | `/api/v1/sessions/{id}/warnings` | 获取 session 级警告 |
| GET | `/api/v1/sessions/{id}/snapshot` | **原子快照**（state + seq 水位 + epoch + in_flight_turn + pending_approvals + pending_questions） |
| GET | `/api/v1/sessions/{id}/children` | 列出子 sessions |
| POST | `/api/v1/sessions/{id}/children` | 创建子 session |
| POST | `/api/v1/sessions/{id}:fork` | Fork session |
| POST | `/api/v1/sessions/{id}:compact` | 压缩 session 上下文 |
| POST | `/api/v1/sessions/{id}:undo` | 撤销最近一轮对话 |

**创建 session 请求体**:
```json
{
  "title": "string",
  "metadata": { "cwd": "/path" },
  "agent_config": {
    "model": "string",
    "thinking": "off|low|medium|high|xhigh|max",
    "permission_mode": "manual|yolo|auto",
    "plan_mode": false,
    "swarm_mode": false
  },
  "workspace_id": "string"
}
```

---

### 1.5 Messages — 消息

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/messages` | 列出消息（支持分页、role 过滤） |
| GET | `/api/v1/sessions/{id}/messages/{msg_id}` | 获取单条消息详情 |

**Message 结构**: `{ id, session_id, role: "user"|"assistant"|"tool"|"system", content: [{type, text/thinking/...}], created_at, prompt_id, parent_message_id, metadata }`

---

### 1.6 Prompts — 提示词

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/prompts` | 列出活跃 + 排队中的 prompts |
| **POST** | `/api/v1/sessions/{id}/prompts` | **提交 prompt**（核心接口） |
| POST | `/api/v1/sessions/{id}/prompts:steer` | 将排队 prompts 导向活跃 turn |
| POST | `/api/v1/sessions/{id}/prompts/{tail}` | 中止/操控 prompt |

**提交 prompt 请求体**:
```json
{
  "content": [{ "type": "text", "text": "..." }],
  "metadata": {},
  "agent_id": "string",
  "model": "string",
  "thinking": "off|low|medium|high|xhigh|max",
  "permission_mode": "manual|yolo|auto",
  "plan_mode": false,
  "swarm_mode": false,
  "goal_objective": "string",
  "goal_control": "pause|resume|cancel"
}
```

---

### 1.7 Approvals — 审批

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/approvals?status=` | 列出待审批请求 |
| POST | `/api/v1/sessions/{id}/approvals/{approval_id}` | **处理审批**（核心接口） |

**审批请求体**:
```json
{
  "decision": "approved|rejected|cancelled",
  "scope": "session",        // 可选，session 级=后续自动审批
  "feedback": "string",
  "selected_label": "string"
}
```

---

### 1.8 Questions — 用户提问

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/questions?status=` | 列出待回答问题 |
| POST | `/api/v1/sessions/{id}/questions/{tail}` | 回答或 dismiss |

---

### 1.9 Tools & MCP — 工具管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/tools?session_id=` | 列出可用工具 |
| GET | `/api/v1/mcp/servers` | 列出已配置的 MCP servers |
| POST | `/api/v1/mcp/servers/{tail}` | 重启指定 MCP server |

---

### 1.10 Skills — 技能

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/skills` | 列出 session 可用 skills |
| POST | `/api/v1/sessions/{id}/skills/{tail}` | 激活 skill（REST 版 `/<skill>` 命令） |

---

### 1.11 Tasks — 后台任务

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/tasks?status=` | 列出 session 的后台任务 |
| GET | `/api/v1/sessions/{id}/tasks/{task_id}` | 获取任务详情（含 output） |
| POST | `/api/v1/sessions/{id}/tasks/{tail}` | 取消后台任务 |

---

### 1.12 Terminals — 终端

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/terminals` | 列出 session 终端 |
| POST | `/api/v1/sessions/{id}/terminals` | 创建终端（cwd, shell, cols, rows） |
| GET | `/api/v1/sessions/{id}/terminals/{terminal_id}` | 获取终端详情 |
| POST | `/api/v1/sessions/{id}/terminals/{tail}` | 关闭终端 |

---

### 1.13 Filesystem — 文件操作

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/sessions/{id}/{tail}` | **FS 操作分发**（支持: list, read, list_many, stat, stat_many, mkdir, search, grep, git_status, diff, open, reveal） |
| GET | `/api/v1/sessions/{id}/fs/{*}` | 下载 workspace 文件 |

---

### 1.14 Files — 文件上传/下载

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/files` | 上传文件 |
| GET | `/api/v1/files/{file_id}` | 下载文件 |
| DELETE | `/api/v1/files/{file_id}` | 删除文件 |

---

### 1.15 Workspaces — 工作区

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/workspaces` | 列出已注册工作区 |
| POST | `/api/v1/workspaces` | 注册工作区（root 幂等） |
| PATCH | `/api/v1/workspaces/{id}` | 重命名工作区 |
| DELETE | `/api/v1/workspaces/{id}` | 注销工作区（不删除磁盘内容） |
| GET | `/api/v1/fs:browse?path=` | 浏览本地目录（服务器文件夹选择器） |
| GET | `/api/v1/fs:home` | 文件夹选择器着陆页（$HOME + 最近工作区） |

---

### 1.16 Models & Providers — 模型管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/models` | 列出模型别名 |
| POST | `/api/v1/models/{tail}` | 设置全局默认模型 |
| GET | `/api/v1/providers` | 列出 providers |
| POST | `/api/v1/providers{refresh_oauth}` | 刷新 OAuth provider 模型元数据 |
| GET | `/api/v1/providers/{provider_id}` | 获取 provider 详情 |

---

### 1.17 Connections — WebSocket 连接

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/connections` | **列出活跃 WebSocket 客户端**（含 subscriptions） |

---

## 二、WebSocket API（推送协议）

### 2.1 连接

```
Endpoint: ws://127.0.0.1:5494/api/v1/ws
Auth: Authorization: Bearer <token> header（WebSocket 握手时传入）
```

### 2.2 消息帧格式

所有消息为 JSON 帧：
```json
{ "type": "<message_type>", "id": "<correlation_id>", "payload": { ... } }
```

### 2.3 控制帧

| 帧类型 | 方向 | 说明 |
|--------|------|------|
| `client_hello` | C→S | 客户端握手，携带 `client_id` |
| `server_hello` | S→C | 服务端确认握手 |
| `subscribe` | C→S | **订阅 session 事件**，携带 `session_ids[]` + 可选 `cursors{seq, epoch}` |
| `subscribe_ack` | S→C | 订阅确认 |
| `unsubscribe` | C→S | 取消订阅 |
| `unsubscribe_ack` | S→C | 取消确认 |
| `ping` / `pong` | ↔ | 心跳保活 |
| `error` | S→C | 错误帧 |
| `resync_required` | S→C | 客户端需重新通过 snapshot 同步 |

### 2.4 文件监听帧

| 帧类型 | 方向 | 说明 |
|--------|------|------|
| `watch_fs_add` | C→S | 添加文件监听（`session_id: {paths, recursive}`） |
| `watch_fs_add_ack` | S→C | 文件监听确认 |
| `watch_fs_remove` | C→S | 移除文件监听 |
| `watch_fs_remove_ack` | S→C | 移除确认 |

### 2.5 控制帧

| 帧类型 | 方向 | 说明 |
|--------|------|------|
| `abort` | C→S | 中止当前 turn |
| `abort_ack` | S→C | 中止确认 |

### 2.6 终端帧

| 帧类型 | 方向 | 说明 |
|--------|------|------|
| `terminal_attach` | C→S | 附加到终端 |
| `terminal_detach` | C→S | 分离终端 |
| `terminal_input` | C→S | 终端输入 |
| `terminal_resize` | C→S | 调整终端大小 |
| `terminal_close` | C→S | 关闭终端 |
| (各含对应 `_ack`) | S→C | 操作确认 |

---

### 2.7 核心事件：`session_event`

WebSocket 最重要的帧类型，所有 session 状态变更通过此帧推送。

**帧结构**:
```json
{
  "type": "session_event",
  "seq": 42,
  "epoch": "...",
  "session_id": "session_xxx",
  "volatile": false,
  "offset": 0,
  "timestamp": "2026-07-06T...",
  "payload": {
    "type": "<event_type>",
    // ... 事件特定字段
  }
}
```

**事件类型一览**:

| `payload.type` | 说明 | 关键字段 |
|----------------|------|---------|
| **`event.session.status_changed`** | **状态变更（最重要）** | `status`, `previous_status`, `current_prompt_id` |
| `event.session.created` | 新 session 创建 | 完整 `session` 对象 |
| `event.workspace.created` | 工作区创建 | `workspace` 对象 |
| `event.workspace.updated` | 工作区更新 | `workspace` 对象 |
| `event.workspace.deleted` | 工作区删除 | `workspace_id`, `root` |
| `event.model_catalog.changed` | 模型目录变更 | `changed[]`, `unchanged[]`, `failed[]` |
| **`turn.started`** | **Turn 开始** | `turnId`, `origin`（user/skill/injection/system...） |
| **`turn.ended`** | **Turn 结束** | `turnId`, `reason`（completed/cancelled/failed/filtered） |
| `agent.status.updated` | Agent 状态更新 | `model`, `contextTokens`, `planMode`, `permission` |
| `session.meta.updated` | Session 元数据变更 | `title`, `patch` |
| `goal.updated` | Goal 状态变更 | `snapshot{status, turnsUsed, tokensUsed, budget}` |
| `skill.activated` | Skill 激活 | `skillName`, `activationId`, `trigger` |
| `plugin_command.activated` | 插件命令激活 | `pluginId`, `commandName` |
| `error` | 错误事件 | `code`（50+ 错误码）, `message`, `retryable` |
| `warning` | 警告事件 | `message`, `code` |

**Session 状态枚举**: `idle` | `running` | `awaiting_approval` | `awaiting_question` | `aborted`

**Turn 原因枚举**: `completed` | `cancelled` | `failed` | `filtered`

**Turn 来源枚举 (origin.kind)**: `user` | `skill_activation` | `plugin_command` | `injection` | `shell_command` | `compaction_summary` | `system_trigger` | `background_task` | `cron_job` | `cron_missed` | `hook_result` | `retry`

---

## 三、典型工作流

### 3.1 发送 prompt 并等待完成（推送模式）

```
1. WS: client_hello → server_hello
2. WS: subscribe { session_ids: ["session_xxx"] }
3. REST: POST /sessions/{id}/prompts { content: [...] }
4. WS: session_event → payload.type = "turn.started"
5. WS: session_event → payload.type = "agent.status.updated" (多次)
6. WS: session_event → payload.type = "turn.ended" { reason: "completed" }
7. WS: session_event → payload.type = "event.session.status_changed" { status: "idle" }
8. REST: GET /sessions/{id}/messages → 获取回复
```

### 3.2 自动审批模式

```
1. WS: session_event → payload.type = "event.session.status_changed" { status: "awaiting_approval" }
2. REST: POST /sessions/{id}/approvals/{approval_id} { decision: "approved", scope: "session" }
3. WS: session_event → status_changed: "running" → ... → status_changed: "idle"
```

### 3.3 创建 session + 发起任务

```
1. REST: POST /sessions { metadata: {cwd}, agent_config: {permission_mode: "auto"} }
2. WS: subscribe { session_ids: [new_id] }
3. REST: POST /sessions/{id}/prompts { content: [{text: "/auto"}] }
4. WS: 等待 turn.ended + status_changed: idle
5. REST: POST /sessions/{id}/prompts { content: [{text: "任务内容"}] }
```

---

## 四、错误码

`session_event` 中的错误事件携带 `code` 字段，共 50+ 种：

`config.invalid`, `session.not_found`, `session.already_exists`, `session.id_invalid`, `session.id_required`, `session.id_empty`, `session.title_empty`, `session.state_not_found`, `session.state_invalid`, `session.fork_active_turn`, `session.export_not_found`, `session.closed`, `session.permission_mode_invalid`, `session.thinking_empty`, `session.model_empty`, `session.plan_mode_invalid`, `session.approval_handler_error`, `session.question_handler_error`, `session.init_failed`, `agent.not_found`, `turn.agent_busy`, `goal.already_exists`, `goal.not_found`, `goal.objective_empty`, `goal.objective_too_long`, `goal.status_invalid`, `goal.not_resumable`, `model.not_configured`, `model.config_invalid`, `auth.login_required`, `context.overflow`, `loop.max_steps_exceeded`, `provider.api_error`, `provider.rate_limit`, `provider.auth_error`, `provider.connection_error`, `skill.not_found`, `skill.type_unsupported`, `skill.name_empty`, `records.write_failed`, `compaction.failed`, `compaction.unable`, `background.task_id_empty`, `mcp.server_not_found`, `mcp.server_disabled`, `mcp.startup_failed`, `mcp.tool_name_collision`, `plugin.not_found`, `plugin.load_failed`, `request.invalid`, `request.work_dir_required`, `request.prompt_input_empty`, `shell.git_bash_not_found`, `not_implemented`, `internal`
