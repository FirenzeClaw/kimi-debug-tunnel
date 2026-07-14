# 策略阻断 → PM 审批闭环 — 设计文档

> 2026-07-14 | 基于现有代码 `src/policy-engine.ts` `src/wire-client.ts` `src/tools/approve-tool.ts` `src/session-watcher.ts`

---

## 问题

当前策略阻断是死路：

- `approveAll()` 遇 `deny` 直接 POST Kimi Server 拒绝 → 记录 BlockEvent
- PM 拿到 block_id 调 `approve_tool` → Kimi Server 端已拒，无法撤销
- reload 后 BlockEvent 全丢 → 彻底锁死

## 目标

PM 能发现阻断 → 决策 → 放行（不创建新工具，升级现有 `approve_tool`）。

---

## 设计

### 链路总览

```
子 session           WireClient / SessionWatcher           PM
──────────           ──────────────────────────           ──
① Write 尝试
② Kimi Server pending
   approval {approval_id}
                     ③ approveAll() → policy check
                        → "deny"
                     ④ POST /approvals/{id} {rejected}
                     ⑤ recordBlock(approval_id="apr_yyy")
                     ⑥ SessionWatcher 检测卡住
                        → reslove watch
                        → 回调 PM { blocks: [{block_id, approval_id}] }
                                                         ⑦ PM 审视
                                                         ⑧ approve_tool(
                                                            approval_id="apr_yyy",
                                                            scope="session"
                                                          )
                                                         ⑨ POST /approvals/{id}
                                                            {approved, scope:session}
                                                         ⑩ policyEngine.unbind()
                                                         ⑪ session 重试 → ✅ 通过
```

### §1 — WireClient: `broadcastBlockEvent` 填 `approval_id`

**文件：** `src/wire-client.ts` L900-954

**现状：** `recordBlock` 不传 `approval_id`，是空字符串。PM 无法用它做 Kimi Server POST。

**改动：** `broadcastBlockEvent` 签名加 `approvalId` 参数，传入 `recordBlock`。调用点（L794, L803）从 `approveAll` 的 `item.approval_id` 传入。

```typescript
// approveAll() L777-795
for (const item of items) {
  ...
  if (decision.action === "deny") {
    await this.transport.apiPost(...reject...);
    this.broadcastBlockEvent(
      sessionId, policy.name, decision.ruleName, toolName,
      decision.message, "deny",
      item.approval_id   // ← 新增
    );
  }
}
```

### §2 — SessionWatcher: 检测 `awaiting_approval` 状态

**文件：** `src/session-watcher.ts` L130-164

**现状：** `pollAll()` 只在 `idle`/`aborted` 时 resolve watch。其他状态（包括 `awaiting_approval`）永远不等，导致 PM watch 永远不返回。

**改动：** `pollAll()` 的终止条件从 `idle | aborted` 扩展为 `idle | aborted | awaiting_approval`。同时 resolve 时附带 blocks 信息（从 `policyEngine.getBlocksBySession()` 获取）。

```typescript
// pollAll() L147
if (cached === "idle" || cached === "aborted" || cached === "awaiting_approval") {
  await this.resolveWatch(watchId, entry);
  continue;
}
```

`resolveWatch` 中，当状态为 `awaiting_approval` 时，除了文本回复，附加 blocks：

```typescript
// resolveWatch() — 在获取文本后
if (status === "awaiting_approval") {
  const blocks = this.policyEngine?.getBlocksBySession(entry.sessionId) ?? [];
  entry.blocks = blocks.map(b => ({ block_id: b.id, approval_id: b.approvalId, ... }));
}
```

> **不会破坏现有行为：** 原来 `idle | aborted` 时 resolve，新增 `awaiting_approval` 只是让 watch 更快返回（而不是无限等待）。

### §3 — `approve_tool` 升级：解绑 policy + 用 `approval_id` 放行

**文件：** `src/tools/approve-tool.ts`

**现状：** 
- `scope="session"` 只打日志
- `approval_id` 存在但在 `deny` 规则下形同虚设（已被拒，重新 POST `approved` 即可覆盖）
- 没有解绑 policy 的能力

**改动：**

```typescript
async ({ block_id, scope, session_id, approval_id }) => {
  // 1. Resolve BlockEvent（标记已处理）
  const block = policyEngine.resolveBlock(block_id, "approved");  // 可为 null
  
  const sid = session_id || block?.sessionId;
  
  // 2. scope="session": 解绑 policy
  if (scope === "session" && sid) {
    policyEngine.unbind(sid);
  }
  
  // 3. 向 Kimi Server POST 放行
  if (approval_id && sid && wireClient.isConnected()) {
    await wireClient.apiPost(
      `/api/v1/sessions/${sid}/approvals/${approval_id}`,
      { decision: "approved", scope }
    );
  }
  
  return { approved: true, block_id, scope, session_id: sid };
}
```

**关键变化：**
- `block_id` 变为可选 → resolveBlock 为 null 时只是跳过，不报错
- `scope="session"` → `policyEngine.unbind()` 永久解绑
- `approval_id` → 直连 Kimi Server 放行

### §4 — 不变的部分

| 组件 | 说明 |
|:--|:--|
| `policy-builtins.ts` | 不改。`deny` 策略保留，PM 决策覆盖。 |
| `list_blocks` | 已有（前一个 plan），不改。 |
| `poll_session` 增强 | 已有（前一个 plan），不改。只需确认 blocks 含 `approval_id`。 |
| 无新工具 | 严格零新工具。 |

---

## 边界情况

| 场景 | 处理 |
|:--|:--|
| reload 后 BlockEvent 丢失 | `approval_id` 仍在 Kimi Server 端。PM 重新 `poll_session` 后直接调 `approve_tool(approval_id)` 跳过低级 `block_id` |
| session 不在 blocking 状态 | `approve_tool` 仍 POST，Kimi Server 返回 404 → approve_tool 静默忽略 |
| `scope="session"` 后 session 再次被阻断 | 已解绑，不复现 |
