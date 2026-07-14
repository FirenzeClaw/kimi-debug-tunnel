# 策略引擎 ↔ Session 监控对接 — 实现计划

> **面向 AI 代理的工作者：** 使用 `subagent-driven-development` 或 `executing-plans` 逐任务实现。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** PM 能通过 MCP 工具（`poll_session`、新增 `list_blocks`）发现策略阻断事件并获取 `block_id`，配合已有的 `approve_tool`/`deny_tool` 完成审批闭环。

**架构：** PolicyEngine 新增 `getBlocksBySession()` 查询接口 → `poll_session` 增强返回 blocks 字段 → 新工具 `list_blocks` 提供全局阻断列表。改动集中在 3 个文件，不碰 SessionWatcher 和 WireClient。

**技术栈：** TypeScript 5.6, MCP SDK 1.12, Zod 3

---

## 依赖图

```
PolicyEngine.getBlocksBySession()     ← 新增查询接口
    ├── poll_session 增强             ← 消费接口，内联 blocks
    └── list_blocks 新工具             ← 消费接口，独立查询
```

**全部并行安全** — poll_session 和 list_blocks 互不依赖，可同时开发。

---

## 任务列表

### 阶段 1：基础 — PolicyEngine 查询接口

- [ ] **任务 1：PolicyEngine 新增 `getBlocksBySession()`**

### 检查点：阶段 1
- [ ] TypeScript 编译零错误

### 阶段 2：核心功能 — MCP 工具

- [ ] **任务 2：`poll_session` 增强 — 返回 blocks 字段**
- [ ] **任务 3：新增 `list_blocks` MCP 工具**

### 检查点：阶段 2
- [ ] TypeScript 编译零错误
- [ ] `npm run build` 成功
- [ ] 工具在 MCP 工具列表中可见（`list_sessions` 可间接验证）

### 阶段 3：验证
- [ ] **任务 4：端到端验证 — 创建 read-only session → 触发 Write 阻断 → poll_session 查看 blocks**

### 检查点：完成
- [ ] PM 可通过 `poll_session` 获取 block_id
- [ ] PM 可通过 `list_blocks` 全局查看阻断
- [ ] `approve_tool(block_id)` 可放行
- [ ] `deny_tool(block_id)` 可拒绝

---

## 任务 1：PolicyEngine 新增 `getBlocksBySession()`

**描述：** 在 `IPolicyEngine` 接口和 `PolicyEngine` 实现中新增按 session 查询阻断的方法。

**验收标准：**
- [ ] `IPolicyEngine` 接口声明 `getBlocksBySession(sessionId: string): BlockEvent[]`
- [ ] `PolicyEngine` 实现方法，过滤 `this.blocks` 中 `sessionId` 匹配且 `!resolved` 的条目
- [ ] TypeScript 编译零错误

**验证：**
- [ ] `npx tsc --noEmit` 通过

**依赖：** 无

**涉及文件：**
- `src/policy-engine.ts` — 接口 + 实现
- `src/policy-types.ts` — BlockEvent 已完备，无需改动

**预估规模：** XS（1 文件，~8 行）

---

### 步骤 1：IPolicyEngine 接口新增方法声明

在 `src/policy-engine.ts` 的 `IPolicyEngine` 接口中（第 16-37 行），`resolveBlock` 之后添加：

```typescript
  /** Get unresolved block events for a specific session. */
  getBlocksBySession(sessionId: string): BlockEvent[];
```

位置：第 37 行 `resolveBlock` 声明之后，接口闭合 `}` 之前。

### 步骤 2：PolicyEngine 类实现方法

在 `src/policy-engine.ts` 的 `PolicyEngine` 类中（第 41-187 行），`getPendingBlocks` 方法之后（第 176 行后）添加：

```typescript
  getBlocksBySession(sessionId: string): BlockEvent[] {
    return Array.from(this.blocks.values()).filter(
      (b) => b.sessionId === sessionId && !b.resolved
    );
  }
```

### 步骤 3：验证编译

```bash
cd D:/code/kimi-session-orchestrator && npx tsc --noEmit
```

预期：零错误。

### 步骤 4：Commit

```bash
git add src/policy-engine.ts
git commit -m "feat(policy): add getBlocksBySession() query method"
```

---

## 任务 2：`poll_session` 增强 — 返回 blocks 字段

**描述：** 在 `poll_session` 的两个返回路径（WS cache 快路径 + file_parse 慢路径）中，追加策略阻断信息。

**验收标准：**
- [ ] WS cache 快路径返回中包含 `blocks` 字段（当有阻断时）
- [ ] file_parse 慢路径返回中包含 `blocks` 字段（当有阻断时）
- [ ] 无阻断时不返回 `blocks` 字段或返回空数组（向后兼容）
- [ ] `services.policyEngine` 为 null 时正常降级（不抛错）
- [ ] TypeScript 编译零错误

**验证：**
- [ ] `npx tsc --noEmit` 通过
- [ ] 端到端测试（见任务 4）

**依赖：** 任务 1

**涉及文件：**
- `src/tools/poll-session.ts`

**预估规模：** XS（1 文件，~15 行）

---

### 步骤 1：添加上下文辅助函数

在 `registerPollSession` 函数体开头（第 9 行附近），`const { wireClient, workflowEngine } = services || {};` 解构中追加 `policyEngine`：

```typescript
const { wireClient, workflowEngine, policyEngine } = services || {};
```

### 步骤 2：创建获取 blocks 的辅助逻辑

在 `registerPollSession` 函数体开头，解构之后添加：

```typescript
const formatBlocks = (sid: string) => {
  const blocks = policyEngine?.getBlocksBySession(sid) ?? [];
  if (blocks.length === 0) return undefined;
  return blocks.map(b => ({
    block_id: b.id,
    action: b.action,
    tool_name: b.toolName,
    rule: b.ruleName,
    policy: b.policyName,
    message: b.message,
    created_at: b.timestamp,
  }));
};
```

### 步骤 3：WS cache 快路径追加 blocks

在快路径中，`const flow = ...` 之后添加：

```typescript
const blks = formatBlocks(session_id);
```

然后在返回对象中追加：

```typescript
text: JSON.stringify({
  sessionId: session_id,
  state: cached,
  stateLabel: stateLabels[cached] || cached,
  complete: cached === "done",
  totalLines: 0,
  source: "ws_cache",
  ...(flow && { flow }),
  ...(blks && { blocks: blks }),
}, null, 2),
```

### 步骤 4：file_parse 慢路径追加 blocks

同样在慢路径中 `const flow = ...` 之后添加 `const blks = formatBlocks(session_id);`，然后在返回对象中追加：

```typescript
text: JSON.stringify({
  ...status,
  stateLabel: stateLabels[status.state] || status.state,
  source: "file_parse",
  ...(flow && { flow }),
  ...(blks && { blocks: blks }),
}, null, 2),
```

### 步骤 5：验证编译

```bash
cd D:/code/kimi-session-orchestrator && npx tsc --noEmit
```

预期：零错误。

### 步骤 6：Commit

```bash
git add src/tools/poll-session.ts
git commit -m "feat(poll): include policy blocks in poll_session response"
```

---

## 任务 3：新增 `list_blocks` MCP 工具

**描述：** 创建 `src/tools/list-blocks.ts`，注册为 MCP 工具 `list_blocks`，支持全局或按 session 过滤阻断列表。

**验收标准：**
- [ ] `list_blocks` 工具在 MCP 工具列表中可见
- [ ] 无参数调用返回所有待处理阻断
- [ ] 带 `session_id` 调用仅返回该 session 的阻断
- [ ] 无阻断时返回 `{ blocks: [], count: 0 }`
- [ ] `policyEngine` 为 null 时返回友好错误
- [ ] TypeScript 编译零错误

**验证：**
- [ ] `npx tsc --noEmit` 通过
- [ ] 端到端测试（见任务 4）

**依赖：** 任务 1

**涉及文件：**
- `src/tools/list-blocks.ts` — 新建
- `src/mcp-server.ts` — 注册

**预估规模：** S（2 文件，~50 行）

---

### 步骤 1：创建 list-blocks.ts

新建 `src/tools/list-blocks.ts`：

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";

export function registerListBlocks(server: McpServer, services: TunnelServices): void {
  const { policyEngine } = services;

  server.tool(
    "list_blocks",
    "列出待处理的策略阻断事件。可选按 session 过滤。",
    {
      session_id: z.string().optional()
        .describe("按 session ID 过滤，省略则列出全部待处理阻断"),
    },
    async ({ session_id }) => {
      if (!policyEngine) {
        return {
          content: [{ type: "text", text: "策略引擎未初始化" }],
          isError: true,
        };
      }

      const rawBlocks = session_id
        ? policyEngine.getBlocksBySession(session_id)
        : policyEngine.getPendingBlocks();

      const blocks = rawBlocks.map(b => ({
        block_id: b.id,
        session_id: b.sessionId,
        tool_name: b.toolName,
        policy: b.policyName,
        rule: b.ruleName,
        action: b.action,
        message: b.message,
        created_at: b.timestamp,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ blocks, count: blocks.length }, null, 2),
        }],
      };
    }
  );
}
```

### 步骤 2：在 mcp-server.ts 中注册

在 `src/mcp-server.ts` 中：

**顶部 import 区**（第 23 行 `registerDenyTool` 之后）：

```typescript
import { registerListBlocks } from "./tools/list-blocks.js";
```

**注册调用区**（第 63 行 `registerDenyTool` 之后，策略工具组内）：

```typescript
  registerListBlocks(server, services);
```

### 步骤 3：验证编译

```bash
cd D:/code/kimi-session-orchestrator && npx tsc --noEmit
```

预期：零错误。

### 步骤 4：Commit

```bash
git add src/tools/list-blocks.ts src/mcp-server.ts
git commit -m "feat(policy): add list_blocks MCP tool for global block visibility"
```

---

## 任务 4：端到端验证

**描述：** 模拟 Act 5 策略演示场景，验证完整闭环：阻断 → 发现 → 审批。

**验收标准：**
- [ ] 创建 `policy="read-only"` session
- [ ] 提交写文件任务，触发 `Write` 阻断
- [ ] `poll_session` 返回带 `blocks` 字段的结果
- [ ] `list_blocks` 列出阻断事件
- [ ] 从 blocks 中获取 `block_id`
- [ ] `approve_tool(block_id)` 放行成功
- [ ] session 继续执行完成

**验证：**
- [ ] 手动执行上述步骤，全部通过

**依赖：** 任务 2, 任务 3

**涉及文件：** 无代码变更，纯手动验证

**预估规模：** —（手动测试）

---

### 验证步骤

```bash
# 1. 构建
npm run build

# 2. 确认 tunnel 运行中，/reload 使新工具生效

# 3. 在 Kimi Code CLI 中执行以下 MCP 工具：

# 3a. 创建 read-only session
create_session(cwd="D:/code/kimi-session-orchestrator/demo",
               permission_mode="manual", policy="read-only",
               title="E2E - 策略阻断验证")
→ 记录 session_id

# 3b. 提交写文件任务
execute_prompt(session_id="<上一步>",
               prompt="在 src/ 下创建 test-block.ts，写入 export const X = 1",
               auto_mode=false)
→ { submitted: true }

# 3c. 等待 5-10 秒后查询阻断
list_blocks
→ 应返回 1 条阻断记录，含 block_id

# 3d. poll_session 也应返回 blocks
poll_session(session_id="<session_id>")
→ blocks 字段应非空

# 3e. 放行阻断
approve_tool(block_id="<block_id>", scope="once")
→ { approved: true }

# 3f. 等待 session 完成，验证文件已创建
```

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `policyEngine` 未初始化（索引阶段早于策略绑定） | poll_session 降级不返回 blocks | `?.` 可选链 + 空数组降级 |
| `BlockEvent` 字段名与 `broadcastBlockEvent` 传入不一致 | blocks 字段缺失或错误 | 任务 1 直接在 `PolicyEngine` 类中操作 `this.blocks`，数据源统一 |
| `permission_mode="auto"` 时无 pending approval → 策略引擎无机会拦截 | 阻断不触发 | 文档中注明需 `permission_mode="manual"` 配合策略 |

## 待定问题

- 无
