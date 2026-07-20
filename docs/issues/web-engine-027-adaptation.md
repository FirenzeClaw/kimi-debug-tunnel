# [DONE] Web 引擎 0.24.x/0.27.0 重构适配分析

> 状态: DONE（分析 + 修复 + 生产回归全部完成） | 分支: `feat/web-engine-0.27-adaptation` | 日期: 2026-07-20
> 依据: API.md（0.27.0 实测重写版）+ 本仓库 src/ 逐行核查
> 结论速览: **2 处必须改（status 状态模型），3 处建议改（健壮性/新能力），其余接口 0.27 实测兼容**

---

## 一、完全被取代 —— 必须升级

### 1. Session 状态枚举模型（核心破坏）

0.22.3 的 `status` 单字段枚举（`idle|running|awaiting_approval|awaiting_question|aborted`）在 0.27.0 被**整体移除**，替换为三元组：

| 0.22.3 | 0.27.0 |
|--------|--------|
| `GET /status → data.status` | `GET /status → {busy, thinking_level, permission, plan_mode, swarm_mode, context_tokens, max_context_tokens, context_usage}`（无 `status` 字段） |
| Session 对象 `status` / `last_prompt` | Session 对象 `busy` / `main_turn_active` / `pending_interaction`（`none`，另两个枚举值待实测） / `archived` |

**受影响代码（5 个文件，11 处）**:

| 位置 | 现状 | 后果 |
|------|------|------|
| `src/wire-client.ts:714-717` `getSessionStatus()` | 读 `resp.status`，0.27 下恒 `undefined` → 返回 `"unknown"` | REST 兜底路径全部失效 |
| `src/wire-client.ts:504-558` `waitForStatus()` | 等 `"idle"`；`"unknown"` 被视为可接受而**提前返回** | 表面不炸，实则"未等完成就拉消息"——隐蔽错误 |
| `src/wire-client.ts:396-412` `handleDirectEvent()` | 依赖 `event.session.status_changed` 的 `payload.status` 枚举驱动状态缓存和 resolver | ⚠️ 0.27 事件载荷是否保留 `status` 字段**未实测**（二进制中 `awaiting_approval`/`previous_status` 字符串仍在，疑似保留），需运行中验证 |
| `src/session-watcher.ts:144,152` | 判 `idle`/`aborted`/`awaiting_approval` | 同上，依赖 `getSessionStatus()` 返回值 |
| `src/poll-command.ts:120,137` POLL_SCRIPT | Python 轮询读 `sdata.get('status')`，0.27 下恒空 → 计入失败 → **3 次后 exit(2) 误报 SERVER_OFFLINE** | 即发即返轮询链路完全断裂（最高危） |

**适配方案**:
- 新增状态归一化层：`busy==false → "idle"`；`busy==true → "running"`；`pending_interaction=="approval" → "awaiting_approval"`（`/status` 无 `pending_interaction`，需并联 `GET /sessions/{id}` 或 snapshot）
- 内部保持现有 `"idle"/"running"/"awaiting_approval"` 词汇表不变，只在 `getSessionStatus()` 一处做映射 → 上层（waitForStatus/session-watcher/tools）零改动
- `"aborted"` 无直接对应字段，改由 `turn.ended` 事件 reason 或 snapshot `in_flight_turn` 推导 ⚠️ 待实测
- POLL_SCRIPT 同步改：`status = 'idle' if sdata.get('busy') is False else 'running'`（注意 `busy` 缺失时不能误判 offline）；`~/.kimi-tunnel/poll.py` 由 execute-prompt/chat-with-session 运行时重写，改 POLL_SCRIPT 即生效

### 2. WS 确认帧类型

0.22.3 `subscribe_ack` 等专用帧 → 0.27 统一泛型帧 `{"type":"ack", id, code, msg, payload}`（实测）。

**受影响**: 无直接破坏 —— `wire-client.ts` 只等 `server_hello`，订阅后不匹配 ack 类型。✅ 无需改。但若未来加订阅确认逻辑，须按 `type=="ack"` + `id` 关联。

---

## 二、使用方式需对应变化 —— 建议升级

### 3. `meta.capabilities` 键名

`background_tasks` → `tasks`（0.27 实测）。`wire-client.ts:238-241` 读取了 capabilities 类型但**未消费具体键**，✅ 无破坏。若将来按 capability 门控功能需用新键名。

### 4. Approvals/Questions 列表强制 `?status=pending`

0.27 缺省返回 `40001`。代码内无 REST 列表调用（审批检测走 WS 事件 + resolveApproval 直 POST，✅ 无破坏）；但 **skill 文档**（AGENTS.md 审批工作流 §示例 curl）若漏参数会踩坑 → 文档同步即可。

### 5. 动作端点空 body 报 50001

`:fork`/`:compact`/`:undo`/`:archive` 必须传 `{}`。本项目当前**未调用**这些端点，✅ 无破坏；新增调用时注意。

---

## 三、0.27 实测兼容 —— 无需改动

| 接口 | 位置 | 验证 |
|------|------|------|
| `POST /api/v1/sessions`（创建） | wire-client.ts:194 | ✅ 实测 body/响应结构不变（`data.id` 等） |
| `POST /sessions/{id}/prompts`（提交） | wire-client.ts:604,650 | ✅ 路由在；`prompt_id`/`user_message_id` 字段名在 0.27 二进制保留（成功响应未实测，无 provider） |
| `GET /sessions/{id}/messages?page_size&role` | wire-client.ts:472,812；poll-command.ts:82 | ✅ 实测 `{items[], has_more}` 结构不变 |
| `GET /api/v1/meta`（握手/心跳） | wire-client.ts:238,740 | ✅ 实测结构兼容，新增 `dangerous_bypass_auth` 字段 |
| `POST /sessions/{id}/approvals/{aid}`（审批决策） | wire-client.ts:836 | ✅ 路由在（二进制确认），未实测 |
| WS v1 握手/订阅/事件推送 | wire-client.ts:297-450 | ✅ 实测 `server_hello`(protocol_version 2) + `ack` 帧；事件名 `event.session.status_changed`/`turn.*`/`prompt.*` 在二进制保留 |
| 锁文件端口检测 | server-lock.ts:33-66 | ✅ 格式不变（`{pid, started_at, host, port, host_version, entry}`） |
| `list_sessions`/`read_session_log`/`poll_session` 兜底 | session-log-reader.ts | ✅ 读本地 wire.jsonl，不经 server API |

---

## 四、可利用的新能力（非必须，独立迭代）

| 新端点 | 用途建议 |
|--------|----------|
| `POST /sessions/{id}:archive` | `session-retire` skill 归档环节由"仅记忆归档"升级为**服务端归档**，退役 session 从列表消失 |
| `POST /sessions/{id}/export`（ZIP） | 退役前完整导出留档 |
| `GET /sessions/{id}/goal` | loop-orchestrator 轮询 goal 状态（`goal.updated` 事件已有） |
| `GET /api/v1/healthz` | 心跳可换轻量端点（现用 `/meta` 也可，非必要） |
| `GET /api/v2/channels` | channel 自省；`agentRPCService` 提供统一 RPC 面（prompt/goal/plan/swarm/compaction），是**长期迁移方向**；`/api/v2/ws` 调用帧格式未确认前不依赖 |

---

## 五、待运行中验证项 —— 全部已实测（2026-07-20 真实 0.27.0 server）

1. ✅ `event.session.status_changed` **不再发送**（整个 turn 周期无一次），由 `event.session.work_changed`（载荷 `{busy, main_turn_active, pending_interaction, last_turn_reason}`）取代 → 已修（commit 9cf9aab）
2. ✅ `pending_interaction` 实测确认 `none`；`approval`/`question` 仍为推断（归一化层精确匹配，未命中落 idle 兜底）
3. ✅ `POST /prompts` 成功响应实测：`{prompt_id, user_message_id, status: "running", content, created_at}`
4. ✅ `aborted` 等价信号：`last_turn_reason` + `turn.ended` 的 `reason`（completed/failed/...），`prompt.completed` 事件亦含 `reason`
5. ✅ 归档过滤参数：实测 `status=archived`/`archived=true`/`include_archived=true` **均不含归档项**——归档 session 在 REST 列表不可见

## 五-b、生产实测新发现（3 个运行时破坏点，均已修复）

| # | 破坏点 | 实测证据 | 修复 |
|---|--------|----------|------|
| A | WS 升级强制鉴权 | server.log: `ws upgrade rejected, reason: missing_credential`；tunnel wsConnected=false（0.22.x 容忍无凭据） | commit 726c578（wsConnect 补 Bearer 头） |
| B | `status_changed` → `work_changed` 事件取代 | 真实帧流：work_changed 携带 busy/pending_interaction，无 status_changed | commit 9cf9aab（handleDirectEvent 并行处理 + applySessionStatus） |
| C | `agent_config.model` 被静默忽略 | 创建传 model / POST profile 均无效仍 `""`；turn 报 `model.not_configured`，不回落默认模型；prompt body 带 `model` 后正常，且有 session 级粘性（实测 k3 / deepseek-v4-flash / deepseek-v4-pro） | commit 1eab294（prompt body 恒带 model：显式 > /auth default_model） |

**端到端回归（2026-07-20）**：create_session → execute_prompt（真实只读审查任务）→ Bash 后台 poll_command → exit 0 拿到 2.5KB 真实回复；wsConnected=true；server.log 无新增 missing_credential；CTX_HIGH 告警正常触发。

## 六、实施顺序建议（已执行完毕）

1. ~~**P0** `getSessionStatus()` 归一化映射 + POLL_SCRIPT busy 判定~~（任务 1-3）
2. ~~**P1** 运行中验证 + 运行时修复~~（任务 7-9：Fix A/B/C）
3. **P2** session-retire 接入 `:archive` + `/export`；skills 文档 curl 示例核对（后续迭代）
4. **P3**（远期）评估 v2 channel RPC 迁移
