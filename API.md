# Kimi Server API 完整参考

> 版本: 0.27.0（0.24.x Web 引擎重构后） | 协议: REST + WebSocket（v1 事件推送 / v2 channel RPC）
> 核实方式: 0.27.0 实测探测（隔离 KIMI_CODE_HOME 实例，2026-07-20）+ 二进制路由字符串比对；标注 ⚠️ 的为推断或未完全验证项
> 旧版参考: 0.22.3 文档见 git 历史；破坏性变更见文末「五、0.22.3 → 0.27.0 破坏性变更」

---

## 通用约定

- **Base URL**: `http://127.0.0.1:<port>` — 端口不再固定 5494，从 `~/.kimi-code/server/lock` 读取（`{pid, started_at, host, port, host_version, entry}`）
- **认证**: `Authorization: Bearer <token>` header；token 持久化于 `~/.kimi-code/server.token`，可用 `kimi server rotate-token` 轮换
- **响应信封**: 所有 REST 响应包裹在 `{ code: 0, msg: "success", data: {...}, request_id: "..." }` 中
- **`code: 0`** = 成功，非 0 = 错误（`40001` 参数校验失败、`40101` 未认证、`40110` 未配置 provider、`50001` 通用错误）
- **动作类端点**（`:fork`/`:compact`/`:undo`/`:archive` 等）: Content-Type 为 `application/json` 时 **body 不能为空**，至少传 `{}`

---

## 一、REST API v1

### 1.1 Meta — 服务器元信息

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/meta` | 服务器版本、capabilities、启动时间 |
| GET | `/api/v1/healthz` | **【新增】** 存活探针，返回 `{ok: true}` |
| POST | `/api/v1/shutdown` | 优雅关闭（非 loopback 绑定时默认 404，需 `--allow-remote-shutdown`） |

**GET /meta 响应 data**（0.27.0 实测）:
```json
{
  "server_version": "0.27.0",
  "capabilities": { "websocket": true, "file_upload": true, "fs_query": true, "mcp": true, "tasks": true, "terminal": true },
  "server_id": "...", "started_at": "...", "open_in_apps": [],
  "dangerous_bypass_auth": false
}
```
> 变化: capabilities 中 `background_tasks` 更名为 `tasks`；新增 `dangerous_bypass_auth` 字段。

---

### 1.2 Auth — 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/auth` | 认证就绪状态（`ready, providers_count, default_model, managed_provider`） |
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

**配置项**: providers, platforms, default_provider, default_model, models, thinking, plan_mode, yolo, default_thinking, default_permission_mode, permission, hooks, services, merge_all_available_skills, extra_skill_dirs, loop_control, background, experimental, telemetry

---

### 1.4 Sessions — 会话管理 ⚠️ 状态模型已重构

| 方法 | 路径 | 说明 |
|------|------|------|
| **POST** | `/api/v1/sessions` | **创建新 session** |
| GET | `/api/v1/sessions` | 列出 sessions（`{items[], has_more}`，分页/过滤参数 ⚠️ 归档过滤参数名未确认） |
| GET | `/api/v1/sessions/{id}` | 获取 session 详情（**新结构，见下**） |
| GET | `/api/v1/sessions/{id}/profile` | 获取 session profile |
| POST | `/api/v1/sessions/{id}/profile` | 更新 profile |
| GET | `/api/v1/sessions/{id}/status` | **实时状态（结构已变，见下）** |
| GET | `/api/v1/sessions/{id}/warnings` | session 级警告 `{warnings[]}` |
| GET | `/api/v1/sessions/{id}/snapshot` | **原子快照（结构已变，见下）** |
| GET | `/api/v1/sessions/{id}/children` | 列出子 sessions |
| POST | `/api/v1/sessions/{id}/children` | 创建子 session |
| POST | `/api/v1/sessions/{id}/export` | **【新增】** 导出 session，返回 **ZIP 二进制**（含 manifest.json 等） |
| POST | `/api/v1/sessions/{id}:fork` | Fork session（body `{}`） |
| POST | `/api/v1/sessions/{id}:compact` | 压缩上下文（body `{}`） |
| POST | `/api/v1/sessions/{id}:undo` | 撤销最近一轮（body `{}`） |
| POST | `/api/v1/sessions/{id}:archive` | **【新增】** 归档 session（body `{}`），返回 `{archived: true}` |

**创建 session 请求体**（0.27.0 实测可用）:
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

**Session 对象新结构**（GET /sessions/{id} 及 snapshot.data.session，0.27.0 实测）:
```json
{
  "id": "session_...", "workspace_id": "wd_...", "title": "...",
  "created_at": "...", "updated_at": "...",
  "busy": false,
  "main_turn_active": false,
  "pending_interaction": "none",
  "archived": false,
  "metadata": { "cwd": "..." },
  "agent_config": { "model": "..." },
  "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
             "cache_creation_tokens": 0, "total_cost_usd": 0,
             "context_tokens": 0, "context_limit": 0, "turn_count": 0 },
  "permission_rules": [],
  "message_count": 0, "last_seq": 0
}
```
> ⛔ **破坏性**: `status`（idle/running/awaiting_approval/...）与 `last_prompt` 字段已**移除**，替换为 `busy` + `main_turn_active` + `pending_interaction` 三元组。`pending_interaction` 取值 ⚠️ 推断为 `none|approval|question`（0.27 实测确认 `none`；枚举全值来自二进制 schema 引用）。

**GET /status 响应 data**（0.27.0 实测，⚠️ 结构已变）:
```json
{
  "busy": false,
  "thinking_level": "off",
  "permission": "manual",
  "plan_mode": false,
  "swarm_mode": false,
  "context_tokens": 0,
  "max_context_tokens": 0,
  "context_usage": 0
}
```
> ⛔ **破坏性**: 不再返回 `status` 字段。空闲/运行判定改用 `busy`（+ session 详情的 `pending_interaction`）。`context_tokens` / `max_context_tokens` 保留。

**GET /snapshot 响应 data**（0.27.0 实测）:
```json
{
  "as_of_seq": 1, "epoch": "ep_...",
  "session": { "...见上 Session 对象新结构..." },
  "messages": { "items": [], "has_more": false },
  "in_flight_turn": null,
  "subagents": [],
  "pending_approvals": [],
  "pending_questions": []
}
```

---

### 1.5 Messages — 消息

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/messages` | 列出消息 `{items[], has_more}`（支持 `page_size`、`role` 过滤，0.27.0 实测） |
| GET | `/api/v1/sessions/{id}/messages/{msg_id}` | 获取单条消息详情 |

**Message 结构**: `{ id, session_id, role: "user"|"assistant"|"tool"|"system", content: [{type, text/thinking/...}], created_at, prompt_id, parent_message_id, metadata }`

---

### 1.6 Prompts — 提示词

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/prompts` | 列出 `{active, queued[]}`（0.27.0 实测） |
| **POST** | `/api/v1/sessions/{id}/prompts` | **提交 prompt**（核心接口；未配置 provider 时返回 `40110`） |
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
**响应 data** ⚠️（字段名 `prompt_id` / `user_message_id` 在 0.27 二进制中保留，成功响应结构未实测）: `{ prompt_id, user_message_id, ... }`

---

### 1.7 Approvals — 审批

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/approvals?status=pending` | 列出待审批请求（⛔ **`status` 查询参数变为必需**，缺省返回 `40001`） |
| POST | `/api/v1/sessions/{id}/approvals/{approval_id}` | **处理审批**（核心接口） |

**审批请求体**:
```json
{
  "decision": "approved|rejected|cancelled",
  "scope": "session",
  "feedback": "string",
  "selected_label": "string"
}
```

---

### 1.8 Questions — 用户提问

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/questions?status=pending` | 列出待回答问题（⛔ `status` 同样必需） |
| POST | `/api/v1/sessions/{id}/questions/{tail}` | 回答或 dismiss |

---

### 1.9 Goal — 目标模式【新增】

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/goal` | 获取 session 当前 goal（无 goal 时 `data: null`，0.27.0 实测） |

> Goal 生命周期主要通过 v2 channel `agentGoalService` / `agentRPCService`（createGoal/pauseGoal/resumeGoal/cancelGoal）驱动。

---

### 1.10 Tools & MCP — 工具管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/tools?session_id=` | 列出可用工具（0.27.0 实测 `{tools[]}`） |
| GET | `/api/v1/mcp/servers` | 列出已配置的 MCP servers（0.27.0 实测 `{servers[]}`） |
| POST | `/api/v1/mcp/servers/{tail}` | 重启指定 MCP server |

---

### 1.11 Skills — 技能

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/skills` | 列出 session 可用 skills（0.27.0 实测 `{skills[]}`） |
| POST | `/api/v1/sessions/{id}/skills/{tail}` | 激活 skill |
| GET | `/api/v1/workspaces/{id}/skills` | **【新增】** 列出 workspace 级 skills |

---

### 1.12 Tasks — 后台任务

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/tasks` | 列出 session 的后台任务（0.27.0 实测 `{items[]}`） |
| GET | `/api/v1/sessions/{id}/tasks/{task_id}` | 获取任务详情（含 output） |
| POST | `/api/v1/sessions/{id}/tasks/{tail}` | 取消后台任务 |

---

### 1.13 Terminals — 终端

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/{id}/terminals` | 列出 session 终端（0.27.0 实测 `{items[]}`） |
| POST | `/api/v1/sessions/{id}/terminals` | 创建终端（cwd, shell, cols, rows） |
| GET | `/api/v1/sessions/{id}/terminals/{terminal_id}` | 获取终端详情 |
| POST | `/api/v1/sessions/{id}/terminals/{tail}` | 关闭终端 |

> 非 loopback 绑定时默认 404（`--allow-remote-terminals` 开启）。

---

### 1.14 Filesystem — 文件操作

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/sessions/{id}/{tail}` | FS 操作分发（list, read, list_many, stat, stat_many, mkdir, search, grep, git_status, diff, open, reveal） |
| GET | `/api/v1/sessions/{id}/fs/{*}` | 下载 workspace 文件 |
| GET | `/api/v1/fs:home` | 文件夹选择器着陆页（0.27.0 实测 `{home, recent_roots[]}`） |
| GET | `/api/v1/fs:browse?path=` | 浏览本地目录（0.27.0 实测 `{path, parent, entries[]}`） |

---

### 1.15 Files — 文件上传/下载

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/files` | 上传文件 |
| GET | `/api/v1/files/{file_id}` | 下载文件 |
| DELETE | `/api/v1/files/{file_id}` | 删除文件 |

> ⛔ `GET /api/v1/files`（列表）在 0.27.0 返回 404 —— 列表能力已移除或从未存在。

---

### 1.16 Workspaces — 工作区

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/workspaces` | 列出已注册工作区（0.27.0 实测 `{items[]}`，含 `{id, root, name, created_at}`） |
| POST | `/api/v1/workspaces` | 注册工作区（root 幂等） |
| PATCH | `/api/v1/workspaces/{id}` | 重命名工作区 |
| DELETE | `/api/v1/workspaces/{id}` | 注销工作区（不删除磁盘内容） |

---

### 1.17 Models & Providers — 模型管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/models` | 列出模型别名（0.27.0 实测 `{items[]}`） |
| POST | `/api/v1/models/{tail}` | 设置全局默认模型 |
| GET | `/api/v1/providers` | 列出 providers（0.27.0 实测 `{items[]}`） |
| POST | `/api/v1/providers{refresh_oauth}` | 刷新 OAuth provider 模型元数据 |
| GET | `/api/v1/providers/{provider_id}` | 获取 provider 详情 |

---

### 1.18 Connections — WebSocket 连接

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/connections` | 列出活跃 WebSocket 客户端（0.27.0 实测 `{connections[]}`） |

---

### 1.19 Debug — 调试【新增，默认关闭】

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/debug/*` | 测试自省端点（如 `/debug/channels`），需启动参数 `--debug-endpoints`，默认 404 |

---

## 二、WebSocket v1 API（事件推送协议）— 保留，细节有变

### 2.1 连接

```
Endpoint: ws://127.0.0.1:<port>/api/v1/ws
Auth: Authorization: Bearer <token> header（WebSocket 握手时传入）
```

### 2.2 握手与订阅（0.27.0 实测）

```
C→S  {"type":"client_hello","id":"h1","payload":{"client_id":"tunnel-xxx"}}
S→C  {"type":"server_hello","timestamp":"...","payload":{
        "ws_connection_id":"conn_...","protocol_version":2,
        "max_event_buffer_size":1000,
        "capabilities":{"event_batching":false,"compression":false}}}
S→C  {"type":"ack","id":"h1","code":0,"msg":"success",
      "payload":{"accepted_subscriptions":[],"resync_required":[],"cursors":{}}}
C→S  {"type":"subscribe","id":"s1","payload":{"session_ids":["session_..."]}}
S→C  {"type":"ack","id":"s1","code":0,"msg":"success",
      "payload":{"accepted":["session_..."],"not_found":[],"resync_required":[],
                 "cursors":{"session_...":{"seq":1,"epoch":"ep_..."}}}}
```

> ⛔ **变化**: `client_hello` / `subscribe` 的确认帧不再是 `subscribe_ack` 等专用类型，统一为 **`{"type":"ack", id, code, msg, payload}`** 泛型帧（按 `id` 关联请求）。`ping`/`pong` 心跳保留。

### 2.3 控制帧

| 帧类型 | 方向 | 说明 |
|--------|------|------|
| `client_hello` / `server_hello` | ↔ | 握手（protocol_version 2） |
| `subscribe` / `unsubscribe` | C→S | 订阅/取消 session 事件（带 `session_ids[]` + 可选 `cursors{seq, epoch}`） |
| `ack` | S→C | **泛型确认帧**（替代 `subscribe_ack`/`unsubscribe_ack` 等） |
| `ping` / `pong` | ↔ | 心跳保活 |
| `error` | S→C | 错误帧 |
| `resync_required` | S→C | 客户端需重新通过 snapshot 同步 |
| `abort` | C→S | 中止当前 turn |
| `watch_fs_add` / `watch_fs_remove` | C→S | 文件监听 |
| `terminal_*` | C→S | 终端 attach/detach/input/resize/close |

### 2.4 核心事件：`session_event`

帧结构（沿用）:
```json
{ "type": "session_event", "seq": 42, "epoch": "...", "session_id": "session_xxx",
  "volatile": false, "offset": 0, "timestamp": "...",
  "payload": { "type": "<event_type>", "...": "..." } }
```

**事件类型**（0.27 二进制中确认存在）:

| `payload.type` | 说明 |
|----------------|------|
| `event.session.status_changed` | 状态变更（⚠️ 载荷字段是否仍为 `status` 枚举未实测，需运行中验证） |
| `event.session.usage_updated` | token/上下文用量更新 |
| `event.session.work_changed` | 工作区变更 |
| `event.assistant.tool_use_started` / `tool_use_delta` / `tool_use_completed` | 工具调用流式事件 |
| `turn.started` / `turn.ended` | Turn 生命周期 |
| `prompt.submitted` / `prompt.completed` | Prompt 生命周期 |
| `agent.status.updated` | Agent 状态（model, contextTokens, planMode, permission） |
| `session.meta.updated` | Session 元数据变更 |
| `goal.updated` | Goal 状态变更 |
| `skill.activated` / `plugin_command.activated` | 激活事件 |
| `error` / `warning` | 错误/警告事件 |

---

## 三、Web 引擎 v2 API（0.24.x 重构新增）— channel RPC 层

新 Web 引擎引入了 **channel 化的 RPC 抽象**：所有领域服务（37 个 channel）通过统一 transport 暴露，Web UI 经 `/api/v2/ws` 调用。

### 3.1 GET `/api/v2/channels` — channel 自省（0.27.0 实测）

返回全部 37 个 channel 的名称、scope、domain 和方法清单（`name, kind: method|event, arity, params`）：

| scope | channels |
|-------|----------|
| **app** | authSummaryService, bootstrapService, configService, flagService, hostFolderBrowser, modelCatalogService, modelService, oauthService, pluginService, providerService, sessionIndex, sessionLifecycleService, workspaceRegistry |
| **session** | sessionApprovalService, sessionFsService, sessionInitService, sessionInteractionService, sessionMetadata, sessionQuestionService, sessionWorkspaceCommandService, sessionWorkspaceContext |
| **agent** | agentActivityView, agentContextMemoryService, agentContextSizeService, agentGoalService, agentMcpService, agentPermissionModeService, agentPermissionRulesService, agentPlanService, agentProfileService, agentPromptService, agentRPCService, agentSwarmService, agentTaskService, agentToolRegistryService, agentUsageService, faultInjectionService |

> 对编排最有用的是 **`agentRPCService`**（agent 级统一 RPC 面）: `prompt, steer, cancel, undoHistory, setModel, setThinking, setPermission, setActiveTools, enterPlan/exitPlan(clearPlan/cancelPlan), enterSwarm/exitSwarm, createGoal/pauseGoal/resumeGoal/cancelGoal, getConfig/getContext/getModel/getPermission/getPlan/getGoal/getSwarmMode/getTasks/getTaskOutput/getTools/getUsage, runShellCommand/cancelShellCommand, beginCompaction/cancelCompaction, clearContext, activateSkill, activatePluginCommand, registerTool/unregisterTool, startBtw, stopTask, detachTask, updatePromptMetadata`。

### 3.2 `/api/v2/ws` — channel RPC transport

- 连接建立后服务端立即推送 `{"type":"ready"}`（0.27.0 实测）
- ⚠️ **调用帧格式未确认**：实测 19 种候选帧（`{type:...}` / `{kind:...}` / JSON-RPC 2.0 等）均无响应亦无错误帧，服务端静默忽略。推测需要额外的激活握手或为 Web UI 内部协议。**编排集成请继续使用 v1 REST + v1 WS，不要依赖 v2/ws。**

---

## 四、典型工作流（v1，已按 0.27 调整）

### 4.1 发送 prompt 并等待完成（推送模式）

```
1. WS v1: client_hello → server_hello + ack
2. WS v1: subscribe { session_ids: ["session_xxx"] } → ack
3. REST: POST /sessions/{id}/prompts { content: [...] }
4. WS: session_event → turn.started → agent.status.updated (多次) → turn.ended
5. REST: GET /sessions/{id}/messages → 获取回复
```

### 4.2 状态轮询（0.27 新判定方式）

```
旧 (0.22.3): GET /status → data.status == "idle" / "awaiting_approval"
新 (0.27.0): GET /status → data.busy == false 即空闲
             GET /sessions/{id} → pending_interaction != "none" 即等待人工介入
             （awaiting_approval ≈ pending_interaction == "approval"）⚠️ 枚举值待实测
```

### 4.3 自动审批模式

```
1. REST: GET /sessions/{id}/approvals?status=pending   （status 参数必需）
2. REST: POST /sessions/{id}/approvals/{approval_id} { decision: "approved", scope: "session" }
```

---

## 五、0.22.3 → 0.27.0 破坏性变更（本项目适配清单）

| # | 变更 | 影响面 | 适配建议 |
|---|------|--------|----------|
| 1 | **`GET /status` 移除 `data.status`**，改为 `{busy, thinking_level, permission, plan_mode, swarm_mode, context_tokens, max_context_tokens, context_usage}` | `wire-client.ts getSessionStatus()`、`poll-command.ts` Python 轮询 | `idle` 判定改 `busy==false`；`aborted` 需另找信号（turn.ended reason / snapshot）⚠️ |
| 2 | **Session 对象移除 `status` / `last_prompt`**，新增 `busy` / `main_turn_active` / `pending_interaction` / `archived` | 所有读 session 详情的代码 | 状态机改三元组推导 |
| 3 | **WS 确认帧统一为 `{"type":"ack"}`**，不再有 `subscribe_ack` 等专用帧 | `wire-client.ts handleDirectEvent` | 按帧 `id` 关联，勿匹配 `subscribe_ack` |
| 4 | **`approvals` / `questions` 列表强制 `?status=pending`** | `approve_tool` / `deny_tool` 相关轮询 | 查询必须带 `status=pending` |
| 5 | **动作端点空 body 报 `50001`**（`:fork`/`:compact`/`:undo`/`:archive`） | 调用方 | 传 `{}` |
| 6 | **新增端点**: `:archive`、`POST /export`(ZIP)、`/goal`、`/healthz`、`/workspaces/{id}/skills`、`/api/v2/*` | — | 可利用 `:archive` 做 session-retire 归档 |
| 7 | `meta.capabilities.background_tasks` → `tasks` | 能力检测 | 按新名读取 |
| 8 | **v2 channel RPC 层引入**（37 channels + /api/v2/ws） | 未来迁移方向 | 暂保持 v1；v2/ws 帧格式待官方文档 |

> 锁文件（`~/.kimi-code/server/lock`）格式不变（`{pid, started_at, host, port, host_version, entry}`），`server-lock.ts` 端口检测无需改动。

---

## 六、错误码

REST 信封错误码（0.27.0 实测）: `40001` 参数校验失败（msg 含具体字段）、`40101` 未认证、`40110` 未配置 provider、`50001` 通用错误（含 "Session not found"、空 body 等）。

`session_event` 中的错误事件携带 `code` 字段（沿用 0.22.3 体系）:

`config.invalid`, `session.not_found`, `session.already_exists`, `session.id_invalid`, `session.id_required`, `session.id_empty`, `session.title_empty`, `session.state_not_found`, `session.state_invalid`, `session.fork_active_turn`, `session.export_not_found`, `session.closed`, `session.permission_mode_invalid`, `session.thinking_empty`, `session.model_empty`, `session.plan_mode_invalid`, `session.approval_handler_error`, `session.question_handler_error`, `session.init_failed`, `agent.not_found`, `turn.agent_busy`, `goal.already_exists`, `goal.not_found`, `goal.objective_empty`, `goal.objective_too_long`, `goal.status_invalid`, `goal.not_resumable`, `model.not_configured`, `model.config_invalid`, `auth.login_required`, `context.overflow`, `loop.max_steps_exceeded`, `provider.api_error`, `provider.rate_limit`, `provider.auth_error`, `provider.connection_error`, `skill.not_found`, `skill.type_unsupported`, `skill.name_empty`, `records.write_failed`, `compaction.failed`, `compaction.unable`, `background.task_id_empty`, `mcp.server_not_found`, `mcp.server_disabled`, `mcp.startup_failed`, `mcp.tool_name_collision`, `plugin.not_found`, `plugin.load_failed`, `request.invalid`, `request.work_dir_required`, `request.prompt_input_empty`, `shell.git_bash_not_found`, `not_implemented`, `internal`
