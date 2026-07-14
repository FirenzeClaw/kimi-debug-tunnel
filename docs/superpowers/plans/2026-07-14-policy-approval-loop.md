# 策略阻断 → PM 审批闭环 — 实现计划

> **面向 AI 代理的工作者：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** PM 能发现被策略阻断的 session（`awaiting_approval`）→ 拿到 `approval_id` → 用 `approve_tool` 放行 → `scope="session"` 解绑策略。

**架构：** wire-client 的 `recordBlock` 填 `approval_id` → SessionWatcher 检测 `awaiting_approval` 并回调 blocks → `approve_tool` 升级：`block_id` 降级为可选 + `scope="session"` 解绑 policy + `approval_id` 直连 Kimi Server。5 文件，无新工具。

**技术栈：** TypeScript 5.6, MCP SDK 1.12, Zod 3

---

## 架构决策

| 决策 | 理由 |
|:--|:--|
| **`execute_prompt` 必须 `auto_mode=true`** | `approveAll()` 只在 `autoApprove=true` 时被调（`wire-client.ts:533,570`）。`auto_mode=false` → `approveAll` 永不运行 → 无 BlockEvent → 整个审批链断裂 |
| **解绑后需重新 `execute_prompt`** | 子 session 被拒后 turn 已结束（idle）。解绑 policy 只是移除拦截，session 不会自动重试——PM 需重新下发 prompt |
| `session_id` 同时用于解绑 + Kimi Server POST | `approve_tool` 从 `block_id` 或显式参数获取，reload 后 block_id 可能丢失，`session_id` 为降级路径 |

---

## 依赖图

```
Task 1: BlockEvent.approvalId 字段     ← 类型基础
  ↓
Task 2: wire-client 传 approval_id    ← 数据源填充
  ↓
Task 3: SessionWatcher 感知阻断       ← 消费 blocks + approval_id
Task 4: approve_tool 升级             ← 独立，可并行于 Task 3
```

---

## 文件清单

| 文件 | 职责 |
|:--|:--|
| `src/policy-types.ts:72-83` | BlockEvent 接口加 `approvalId` |
| `src/wire-client.ts:794,803,900,929` | `broadcastBlockEvent` 加参数 + `recordBlock` 填 `approvalId` |
| `src/session-watcher.ts:3,10,22,147,158,167` | WatchEntry + 构造 + pollAll 条件 + resolveWatch 含 blocks |
| `src/tools/session-watch.ts:10,48,60,93` | getWatcher + getResult/continueWatch 返回含 blocks |
| `src/tools/approve-tool.ts:15,23,30,38` | block_id 可选 + unbind + 降级路径 |

---

## 任务列表

### 阶段 1：基础 — 类型 + 数据源

- [ ] **任务 1：BlockEvent 加 `approvalId` 字段**
- [ ] **任务 2：wire-client 广播阻断时传 `approval_id`**

### 检查点：阶段 1
- [ ] `npx tsc --noEmit` 零错误

### 阶段 2：消费端 — SessionWatcher + approve_tool

- [ ] **任务 3：SessionWatcher 感知 `awaiting_approval` + 返回 blocks**
- [ ] **任务 4：`approve_tool` 升级 — unbind + 降级 block_id**

### 检查点：阶段 2
- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run build` 成功

### 阶段 3：E2E 验证

- [ ] **任务 5：端到端验证**

### 检查点：完成
- [ ] PM 通过 watch/get_watch_result 拿到 blocked session 的 blocks + approval_id
- [ ] PM 调用 `approve_tool(approval_id="..", scope="session")` 放行成功
- [ ] 子 session 继续执行完成

---

## 任务 1：BlockEvent 加 `approvalId` 字段

**描述：** `BlockEvent` 接口当前不存 Kimi Server 的 `approval_id`，导致 PM 无法用它做 Kimi Server POST。新增可选字段。

**依赖：** 无

**涉及文件：**
- `src/policy-types.ts:72-83`

**预估规模：** XS（1 文件，+2 行）

---

### 步骤 1：添加字段

修改 `src/policy-types.ts`，在 `BlockEvent` 接口的 `resolution` 之后、`}` 之前插入：

```typescript
/** A blocked tool call event, recorded for audit and dashboard display. */
export interface BlockEvent {
  id: string;
  sessionId: string;
  toolName: string;
  policyName: string;
  ruleName: string;
  action: "deny" | "require_approval";
  message: string;
  timestamp: string;
  resolved: boolean;
  resolution: "approved" | "denied" | null;
  /** Kimi Server approval ID — used by PM to POST override via approve_tool. */
  approvalId?: string;
}
```

插入位置：`resolution` 行之后（L82→L83 之间）。

### 步骤 2：验证编译

```bash
cd D:/code/kimi-session-orchestrator && npx tsc --noEmit
```

预期：零错误（可选字段不破坏现有代码）。

---

## 任务 2：wire-client 广播阻断时传 `approval_id`

**描述：** `broadcastBlockEvent` 当前不传 `approvalId`。需在签名、WebSocket 广播 payload、`recordBlock` 调用三处补上。调用方 `approveAll` 已有 `item.approval_id`，直接传入。

**依赖：** 任务 1

**涉及文件：**
- `src/wire-client.ts:794,803,900-907,911-922,929-940`

**预估规模：** XS（1 文件，~10 行）

---

### 步骤 1：`broadcastBlockEvent` 签名加参数

修改 `src/wire-client.ts` L900-907：

```typescript
private broadcastBlockEvent(
  sessionId: string,
  policyName: string,
  ruleName: string,
  toolName: string,
  message: string,
  action: "deny" | "require_approval",
  approvalId?: string
): void {
```

### 步骤 2：WebSocket 广播 payload 含 `approvalId`

修改 L911-922 的 `event` 对象，在 `payload` 中追加：

```typescript
const event = {
  type: "policy.block",
  payload: {
    blockId,
    sessionId,
    policyName,
    ruleName,
    toolName,
    message,
    action,
    timestamp: new Date().toISOString(),
    ...(approvalId && { approvalId }),
  },
};
```

### 步骤 3：`recordBlock` 调用含 `approvalId`

修改 L929-940 的 `recordBlock` 调用：

```typescript
this.policyEngine.recordBlock({
  id: blockId,
  sessionId,
  toolName,
  policyName,
  ruleName,
  action,
  message,
  timestamp: new Date().toISOString(),
  resolved: false,
  resolution: null,
  ...(approvalId && { approvalId }),
});
```

### 步骤 4：调用方传入 `item.approval_id`

修改 L794 — `deny` 分支：

```typescript
this.broadcastBlockEvent(
  sessionId, policy.name, decision.ruleName || "(default)",
  toolName, decision.message || "", "deny",
  item.approval_id
);
```

修改 L803 — `require_approval` 分支：

```typescript
this.broadcastBlockEvent(
  sessionId, policy.name, decision.ruleName || "(default)",
  toolName, decision.message || "", "require_approval",
  item.approval_id
);
```

### 步骤 5：验证编译

```bash
cd D:/code/kimi-session-orchestrator && npx tsc --noEmit
```

预期：零错误。

---

## 任务 3：SessionWatcher 感知 `awaiting_approval` + 返回 blocks

**描述：** SessionWatcher 的 `pollAll()` 只在 `idle`/`aborted` 时 resolve watch。`awaiting_approval` 时无限等。需扩展终止条件，resolve 时附加 blocks 信息。需注入 `policyEngine` 引用。

**依赖：** 任务 2

**涉及文件：**
- `src/session-watcher.ts:3,10,22,147,158,167-203`
- `src/tools/session-watch.ts:10,48,60,93`

**预估规模：** S（2 文件，~40 行）

---

### 步骤 1：SessionWatcher 构造函数注入 `policyEngine`

修改 `src/session-watcher.ts`：

**顶部 import（L1 之后新增）：**
```typescript
import type { IPolicyEngine } from "./policy-engine.js";
```

**WatchEntry 接口（L3-10）— 加 `blocks` 字段：**
```typescript
interface WatchEntry {
  sessionId: string;
  status: "watching" | "done" | "error";
  result: string | null;
  error: string | null;
  blocks: Array<{ block_id: string; approval_id?: string; tool_name: string; action: string; message: string }> | null;
  createdAt: number;
  resolvedAt: number | null;
}
```

**构造函数（L22-23）：**
```typescript
private policyEngine: IPolicyEngine | undefined;

constructor(wireClient: WireClient, policyEngine?: IPolicyEngine) {
  this.wireClient = wireClient;
  this.policyEngine = policyEngine;
}
```

**`watch()` 方法（L33-40）— 初始化 `blocks: null`：**
```typescript
this.watches.set(watchId, {
  sessionId,
  status: "watching",
  result: null,
  error: null,
  blocks: null,
  createdAt: Date.now(),
  resolvedAt: null,
});
```

### 步骤 2：`pollAll()` 加 `awaiting_approval` 条件

修改 L147：
```typescript
if (cached === "idle" || cached === "aborted" || cached === "awaiting_approval") {
  await this.resolveWatch(watchId, entry);
  continue;
}
```

修改 L158：
```typescript
if (status === "idle" || status === "aborted" || status === "awaiting_approval") {
  await this.resolveWatch(watchId, entry);
}
```

但 L158 的 `status` 变量名来自 `this.wireClient.getSessionStatus()` 的返回值。需确认它返回的状态字符串与 WS cache 一致。**不做额外改动**（两者理论上相同）。

### 步骤 3：`resolveWatch` — 填充 blocks

在 `resolveWatch` 方法中，获取文本回复**之前**，先查 blocks：

`resolveWatch` 开头（L167 之后）新增：

```typescript
private async resolveWatch(watchId: string, entry: WatchEntry): Promise<void> {
  try {
    // Fetch blocks if policy engine is available
    if (this.policyEngine) {
      const rawBlocks = this.policyEngine.getBlocksBySession(entry.sessionId);
      if (rawBlocks.length > 0) {
        entry.blocks = rawBlocks.map(b => ({
          block_id: b.id,
          approval_id: b.approvalId,
          tool_name: b.toolName,
          action: b.action,
          message: b.message,
        }));
      }
    }

    // Fetch the last assistant response (existing code)
    const originalSession = this.wireClient.getSessionId();
    ...
```

### 步骤 4：`getResult` 返回 blocks

修改 `session-watcher.ts` L52-57 `getResult` 返回类型加 `blocks`：

```typescript
getResult(watchId: string): {
  status: string; result: string | null; error: string | null;
  blocks: WatchEntry["blocks"];
} | null {
  const entry = this.watches.get(watchId);
  if (!entry) return null;
  if (entry.status === "watching") return null;
  return {
    status: entry.status, result: entry.result, error: entry.error,
    blocks: entry.blocks,
  };
}
```

### 步骤 5：`session-watch.ts` — `getWatcher` 传 `policyEngine`

修改 `src/tools/session-watch.ts` L8-13：

```typescript
function getWatcher(services: TunnelServices): SessionWatcher {
  if (!watcher) {
    watcher = new SessionWatcher(services.wireClient, services.policyEngine);
  }
  return watcher;
}
```

### 步骤 6：`session-watch.ts` — `getWatchResult` + `continueWatch` 返回 blocks

修改 `registerGetWatchResult` 的返回对象（L58-66），在 `error` 之后追加：

```typescript
text: JSON.stringify({
  ready: true,
  status: result.status,
  result: result.result,
  error: result.error,
  ...(result.blocks && result.blocks.length > 0 && { blocks: result.blocks }),
}, null, 2),
```

修改 `registerContinueWatch` 的 resp 对象（L93-98），在 `error` 之后追加：

```typescript
const resp: Record<string, unknown> = {
  ready: true,
  result: result.result,
};
if (result.next_watch_id) resp.next_watch_id = result.next_watch_id;
if (result.error) resp.error = result.error;
if (result.blocks && result.blocks.length > 0) resp.blocks = result.blocks;
```

> `continueWatch` 的返回值来自 `entry` 不直接包含 blocks，需要从 `continueWatch` 方法内拿到 blocks。检查 `continueWatch`（L68-113）— 它在调用 `getResult` 之前先 delete watch。需改为先 `getResult` 拿 blocks，再保留到 response。

修改 `continueWatch`（L77-88）：

```typescript
async continueWatch(watchId: string, nextInstruction?: string): Promise<...> {
  const entry = this.watches.get(watchId);
  if (!entry) return { ready: false, error: "watch not found" };
  if (entry.status === "watching") return null;

  // Capture blocks before deleting
  const blocks = entry.blocks;

  this.watches.delete(watchId);

  const response = {
    ready: true,
    result: entry.result,
    error: entry.error,
    ...(blocks && blocks.length > 0 && { blocks } as any),
  };
  // ... rest unchanged
```

### 步骤 7：验证编译

```bash
cd D:/code/kimi-session-orchestrator && npx tsc --noEmit
```

预期：零错误。

---

## 任务 4：`approve_tool` 升级 — unbind + 降级 block_id

**描述：** `block_id` 从必需降级为可选（reload 后可能丢失）。`scope="session"` 时调 `policyEngine.unbind()`。其他逻辑不变。

**依赖：** 任务 2

**涉及文件：**
- `src/tools/approve-tool.ts:15,23,30,38`

**预估规模：** XS（1 文件，~15 行）

---

### 步骤 1：`block_id` 改为可选

修改 L15：
```typescript
block_id: z.string().optional()
  .describe("阻断事件 ID。从 poll_session 或 watch_result 的 blocks 中获取。",
```

### 步骤 2：`resolveBlock` 降级处理

修改 L23-33：
```typescript
async ({ block_id, scope, session_id, approval_id }) => {
  // Resolve block event if available (may be null after tunnel reload)
  let sid = session_id;
  if (block_id && policyEngine) {
    const block = policyEngine.resolveBlock(block_id, "approved");
    if (block) {
      sid = sid || block.sessionId;
    }
  }

  if (!sid) {
    return { content: [{ type: "text", text: "缺少 session_id：请提供 session_id 或有效的 block_id" }], isError: true };
  }

  try {
```

### 步骤 3：`scope="session"` → unbind policy

替换 L37-41 的注释块：
```typescript
// If scope=session, unbind the policy entirely
if (scope === "session" && policyEngine) {
  policyEngine.unbind(sid);
  process.stderr.write(`[approve-tool] Policy unbound for session ${sid}\n`);
}
```

### 步骤 4：POST Kimi Server 放行（保持现有逻辑）

L44-53 逻辑不变 — `approval_id` 存在时 POST。**额外处理：** 无论 `approval_id` 是否存在，`scope="session"` 解绑后 session 后续工具调用不再被拦。

### 步骤 5：验证编译

```bash
cd D:/code/kimi-session-orchestrator && npx tsc --noEmit
```

预期：零错误。

### 步骤 6：构建

```bash
npm run build
```

---

## 任务 5：端到端验证

**描述：** 完整走通阻断→发现→放行链路。

**依赖：** 任务 3, 任务 4

---

### 验证步骤

```bash
# 前提：/reload 使新 dist/ 生效

# 1. 创建 read-only session
## MCP: create_session(cwd="D:/code/kimi-session-orchestrator/demo",
##       permission_mode="manual", policy="read-only",
##       title="E2E - 审批闭环验证")
## → session_id

# 2. 提交写文件任务（必须 auto_mode=true 触发 approveAll！）
## MCP: execute_prompt(session_id, "创建 src/test-approve.ts，写入 export const X=1",
##       auto_mode=true)
## → { submitted: true, poll_command: "..." }

# 3. 等待子 session 被策略阻断
## Bash(run_in_background=true): <poll_command 的值>
## 或 MCP: watch_session(session_id) → 等 SessionWatcher 检测 idle
## → 拿到 blocks: [{ block_id, approval_id, tool_name:"Write", action:"deny" }]

# 4. PM 审视 → 放行（解绑 policy）
## MCP: approve_tool(approval_id="<上一步>", scope="session",
##       session_id="<session_id>")
## → { approved: true }

# 5. 重新提交任务（policy 已解绑，Write 不再被拦）
## MCP: execute_prompt(session_id, "继续：创建 src/test-approve.ts，写入 export const X=1",
##       auto_mode=true)

# 6. 验证文件已创建
## MCP: poll_session(session_id) → state: "done"
## 检查 demo/src/test-approve.ts 存在且含 export const X=1
```

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `auto_mode=false` 使 `approveAll` 从未运行 | 无 BlockEvent → 整个审批链断路 | 架构决策明确要求 `auto_mode=true`，E2E 验证覆盖 |
| `submitPrompt` 在 `awaiting_approval` + `!autoApprove` 时 throw（L657-662） | PM 解绑后重新提交时若 session 仍未 idle 会报错 | 解绑后 session turn 自然结束 → idle，时序上安全；出问题时重试 |
| `continueWatch` 中 blocks 在 delete 后丢失 | `continueWatch` 返回无 blocks | 步骤 6 改为先捕获 blocks 再 delete |
| `approval_id` 为空时 `approve_tool` 只解绑不 POST | scope="session" 解绑后 session 下次工具调用自动通过 | 可接受——解绑是最终方案 |
| SessionWatcher 状态字符串 `awaiting_approval` 与 REST API 返回值大小写不一致 | pollAll 快慢路径判定不同 | 两处统一用 `===` 精确匹配，WS cache 和 REST 返回相同格式 |
