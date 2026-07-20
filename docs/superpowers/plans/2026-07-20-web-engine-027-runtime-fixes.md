# Web 引擎 0.27 运行时破坏修复实现计划（Fix A/B/C）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 0.27 真实环境生产测试暴露的 3 个运行时破坏点，使 tunnel 在 0.27 下恢复完整的"创建 session → 提交 prompt → 事件驱动等待 → 拿到回复"链路，且不回归 0.22.x。

**架构：** Fix A 为 WS 握手补 Bearer 头（0.27 强制鉴权）；Fix B 在 `handleDirectEvent` 并行处理新事件 `event.session.work_changed`（busy 模型），抽出共享的 `applySessionStatus()` 供新旧事件复用；Fix C 在 prompt body 恒带 `model`（显式指定 > server `/auth` default_model），解决 `agent_config.model` 被忽略导致的 `model.not_configured`。

**技术栈：** TypeScript 5.6（strict）、Node ≥22（node:test）、ws 8.x

**分支：** `feat/web-engine-0.27-adaptation`

**上游计划：** `docs/superpowers/plans/2026-07-20-web-engine-027-adaptation.md`（任务 1-3 已完成；本计划取代其任务 4-6）

---

## 实测依据（2026-07-20 真实 0.27.0 server）

| # | 破坏点 | 实测证据 |
|---|--------|----------|
| A | WS 强制鉴权 | server.log: `ws upgrade rejected, reason: missing_credential`；tunnel `wsConnected:false` |
| B | `event.session.status_changed` 被取代 | 实测帧流：`event.session.work_changed` 载荷 `{busy, main_turn_active, pending_interaction, last_turn_reason}`，全程无 status_changed |
| C | `agent_config.model` 被静默忽略 | 创建传 model / POST profile 更新均无效（仍 `""`）；turn 报 `model.not_configured: Model not set`；prompt body 带 `model` 后正常 |
| C-补 | model 粘性 | prompt 带 model 成功后，后续不带 model 的 prompt 沿用（E1/E3 实测）；`kimi-code/k3`、`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 均验证可用 |
| 保留 | `POST /prompts` 响应 | `{prompt_id, user_message_id, status, content, created_at}` 结构保留 |
| 保留 | 其他事件 | `turn.started`/`turn.ended`（含 error 对象）/`prompt.completed`（含 reason）/`agent.status.updated`/`session.meta.updated` 均实测到达 |

---

## 文件清单

| 文件 | 职责 | 动作 |
|------|------|------|
| `src/wire-client.ts` | Fix A（wsConnect 鉴权）+ Fix B（work_changed + applySessionStatus）+ Fix C（model 解析链） | 修改 |
| `tests/wire-client-status.test.mjs` | Fix B 单测（work_changed 映射 + resolver 唤醒） | 创建 |
| `tests/wire-client-model.test.mjs` | Fix C 单测（model 解析优先级 + body 注入） | 创建 |
| `API.md` | 修正实测偏差（last_prompt 保留、work_changed、WS 鉴权、model 行为） | 修改 |
| `docs/issues/web-engine-027-adaptation.md` | 回填实测结论，状态推进 | 修改 |
| `AGENTS.md` | 0.27 适配注记（WS 鉴权、model 必带） | 修改 |
| `CHANGELOG.md` | 适配条目 | 修改 |

---

## 任务列表

### 阶段 1：三个运行时修复

---

### 任务 7：Fix A — WS 握手 Bearer 鉴权

**描述：** `wsConnect()` 创建 WebSocket 时不带任何凭据，0.27 拒绝升级（`missing_credential`）。补上 Authorization 头（token 为空时传空 headers 对象，保持行为一致）。

**文件：** 修改 `src/wire-client.ts:306`

- [ ] **步骤 1：修改 wsConnect**

将 `src/wire-client.ts:306`：

```ts
      const ws = new WebSocket(this.wsUrl);
```

替换为：

```ts
      // 0.27 起 WS 升级强制鉴权（missing_credential 拒绝）；0.22.x 容忍但也接受该头
      const ws = new WebSocket(this.wsUrl, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
```

- [ ] **步骤 2：构建**

运行：`npm run build`，预期零错误。

- [ ] **步骤 3：Commit**

```bash
git add src/wire-client.ts
git commit -m "fix: WS 握手补 Bearer 头——0.27 强制鉴权（missing_credential）"
```

**验收标准：**
- [ ] `npm run build` 零错误
- [ ] 改动仅 1 处构造调用，无其他逻辑变化

**依赖：** 无
**预估规模：** XS

---

### 任务 8：Fix B — work_changed 事件处理 + applySessionStatus 提取

**描述：** 0.27 不再发 `event.session.status_changed`，改发 `event.session.work_changed`（载荷含 `busy`/`pending_interaction`）。抽取共享方法 `applySessionStatus()`（缓存更新 + resolver 唤醒），新旧两个事件分支都走它。配套单测直接调用私有方法（TS private 运行时可访问）。

**文件：**
- 修改：`src/wire-client.ts`（handleDirectEvent，约 393-413 行）
- 测试：`tests/wire-client-status.test.mjs`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/wire-client-status.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { WireClient } from "../dist/wire-client.js";

// TS private 仅编译期约束，.mjs 中可直接触达以做单测
function makeClient() {
  return new WireClient(); // 构造不发起连接，baseUrl/token 来自 env 缺省
}

test("work_changed: busy=false + none → idle 并写入缓存", () => {
  const c = makeClient();
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: false, pending_interaction: "none", session_id: "s1" },
  });
  assert.equal(c.getCachedStatus("s1"), "idle");
});

test("work_changed: busy=true → running", () => {
  const c = makeClient();
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: true, pending_interaction: "none", session_id: "s1" },
  });
  assert.equal(c.getCachedStatus("s1"), "running");
});

test("work_changed: busy=false + approval → awaiting_approval", () => {
  const c = makeClient();
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: false, pending_interaction: "approval", session_id: "s1" },
  });
  assert.equal(c.getCachedStatus("s1"), "awaiting_approval");
});

test("work_changed: 唤醒 idle resolver 并清空队列", () => {
  const c = makeClient();
  let got = null;
  c.statusResolvers.set("s1", [{ resolve: (v) => { got = v; }, reject: () => {} }]);
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: false, pending_interaction: "none", session_id: "s1" },
  });
  assert.equal(got, "idle");
  assert.equal(c.statusResolvers.has("s1"), false);
});

test("work_changed: awaiting_approval 只唤醒首个 resolver 且保留队列", () => {
  const c = makeClient();
  let got = null;
  c.statusResolvers.set("s1", [{ resolve: (v) => { got = v; }, reject: () => {} }]);
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: false, pending_interaction: "approval", session_id: "s1" },
  });
  assert.equal(got, "awaiting_approval");
  assert.equal(c.statusResolvers.has("s1"), true);
});

test("旧事件 status_changed 仍生效（0.22.x 兼容）", () => {
  const c = makeClient();
  c.handleDirectEvent({
    type: "event.session.status_changed",
    payload: { status: "idle", session_id: "s1" },
  });
  assert.equal(c.getCachedStatus("s1"), "idle");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run build && node --test tests/wire-client-status.test.mjs`
预期：FAIL —— work_changed 相关用例全部失败（`getCachedStatus` 返回 null），旧事件用例通过

- [ ] **步骤 3：实现 applySessionStatus + work_changed 分支**

在 `src/wire-client.ts` 中，将 `handleDirectEvent` 现有的 status_changed 分支（约 396-413 行）：

```ts
    if (type === "event.session.status_changed" && payload?.status) {
      cached.status = payload.status as string;
      cached.updatedAt = Date.now();
      this.sessionStateCache.set(sessionId, cached);

      // Notify waiting sendPrompt calls
      const resolvers = this.statusResolvers.get(sessionId);
      if (resolvers && resolvers.length > 0) {
        const status = payload.status as string;
        if (status === "idle" || status === "aborted") {
          for (const r of resolvers) r.resolve(status);
          this.statusResolvers.delete(sessionId);
        } else if (status === "awaiting_approval") {
          const resolver = resolvers[0];
          if (resolver) resolver.resolve("awaiting_approval");
        }
      }
    }
```

替换为：

```ts
    // 0.22.x 事件模型：status 枚举直通
    if (type === "event.session.status_changed" && payload?.status) {
      this.applySessionStatus(sessionId, payload.status as string);
    }

    // 0.24+ 事件模型：work_changed 携带 busy/pending_interaction（status_changed 不再发送）
    if (type === "event.session.work_changed" && payload) {
      const mapped = normalizeSessionStatus(
        { busy: payload.busy as boolean | undefined },
        { pending_interaction: payload.pending_interaction as string | undefined }
      );
      if (mapped !== "unknown") {
        this.applySessionStatus(sessionId, mapped);
      }
    }
```

注意：替换后 `handleDirectEvent` 开头的 `const cached = ...`（约 394 行）仍被 turn.started 分支使用，保留不动。

在 `handleDirectEvent` 方法之后新增私有方法：

```ts
  /**
   * 统一的状态落点：更新 WS 缓存并唤醒 waitForStatus resolver。
   * idle/aborted 唤醒全部并清空队列；awaiting_approval 只唤醒首个（保留队列等最终态）。
   */
  private applySessionStatus(sessionId: string, status: string): void {
    const cached = this.sessionStateCache.get(sessionId) || { status: "unknown", updatedAt: 0 };
    cached.status = status;
    cached.updatedAt = Date.now();
    this.sessionStateCache.set(sessionId, cached);

    const resolvers = this.statusResolvers.get(sessionId);
    if (!resolvers || resolvers.length === 0) return;
    if (status === "idle" || status === "aborted") {
      for (const r of resolvers) r.resolve(status);
      this.statusResolvers.delete(sessionId);
    } else if (status === "awaiting_approval") {
      resolvers[0]?.resolve("awaiting_approval");
    }
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run build && node --test tests/wire-client-status.test.mjs && node --test tests/status-normalize.test.mjs`
预期：6 个新用例全过；归一化 10 个用例不受影响

- [ ] **步骤 5：Commit**

```bash
git add src/wire-client.ts tests/wire-client-status.test.mjs
git commit -m "fix: 处理 0.24+ work_changed 事件——status_changed 已被取代，提取 applySessionStatus"
```

**验收标准：**
- [ ] work_changed 的 busy/pending_interaction 正确映射到 idle/running/awaiting_approval 并驱动缓存与 resolver
- [ ] 旧 status_changed 分支行为不变（0.22.x 兼容）
- [ ] 6 个新单测全过，既有 10 个单测不回归，`npm run build` 零错误

**依赖：** 无（与任务 7 无代码冲突；同文件须串行执行）
**预估规模：** M

---

### 任务 9：Fix C — prompt body 恒带 model

**描述：** 0.27 静默忽略 `agent_config.model`，空 model 的 session turn 必败（`model.not_configured`）。在 `submitPrompt`/`sendPrompt` 的 body 构建处恒带 `model`：createSession 显式指定的 model 优先（记录到 sessionModels map），否则用 server `/auth` 的 `default_model`（惰性获取并缓存）。model 有粘性（实测），恒带幂等且覆盖 server 重启丢粘性的边界。

**文件：**
- 修改：`src/wire-client.ts`（字段区约 100 行、createSession 约 194-197、submitPrompt 约 602-607、sendPrompt 约 644-649、新增 resolvePromptModel 方法）
- 测试：`tests/wire-client-model.test.mjs`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/wire-client-model.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { WireClient } from "../dist/wire-client.js";

// stub 掉网络与等待，只验证 body 构建与 model 解析优先级
function makeStubClient(authDefault = "server/default-model") {
  const c = new WireClient();
  const captured = [];
  c.connected = true;
  c.transport = {
    apiGet: async () => ({ default_model: authDefault }),
    apiPost: async (path, body) => { captured.push(body); return { prompt_id: "p1" }; },
  };
  c.waitForStatus = async () => "idle";
  c.wsSubscribe = () => {};
  return { c, captured };
}

test("createSession 显式 model 优先于 server default", async () => {
  const { c, captured } = makeStubClient();
  c.sessionModels.set("s1", "deepseek/deepseek-v4-flash");
  await c.submitPrompt("s1", "hi");
  assert.equal(captured[0].model, "deepseek/deepseek-v4-flash");
});

test("无显式 model 时用 server /auth default_model", async () => {
  const { c, captured } = makeStubClient("kimi-code/k3");
  await c.submitPrompt("s1", "hi");
  assert.equal(captured[0].model, "kimi-code/k3");
});

test("server default 获取失败时省略 model 字段（不阻断提交）", async () => {
  const c = new WireClient();
  const captured = [];
  c.connected = true;
  c.transport = {
    apiGet: async () => { throw new Error("boom"); },
    apiPost: async (path, body) => { captured.push(body); return { prompt_id: "p1" }; },
  };
  c.waitForStatus = async () => "idle";
  c.wsSubscribe = () => {};
  await c.submitPrompt("s1", "hi");
  assert.equal("model" in captured[0], false);
});

test("/auth 只拉取一次（缓存）", async () => {
  const { c } = makeStubClient();
  let calls = 0;
  const origGet = c.transport.apiGet;
  c.transport.apiGet = async (...a) => { calls++; return origGet(...a); };
  await c.submitPrompt("s1", "hi");
  await c.submitPrompt("s1", "hi2");
  assert.equal(calls, 1);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run build && node --test tests/wire-client-model.test.mjs`
预期：FAIL —— `captured[0].model` 为 undefined

- [ ] **步骤 3：实现 model 解析链**

3a. `src/wire-client.ts` 字段区（约 100 行 `statusResolvers` 声明附近）追加：

```ts
  // Fix C: 0.27 忽略 agent_config.model，prompt body 必须恒带 model（有粘性，幂等）
  private sessionModels = new Map<string, string>();
  private serverDefaultModel: string | null = null;
```

3b. `createSession` 方法（约 194-197）：找到 `agent_config` 中 model 入参的来源（方法参数），在创建成功后追加记录。若当前签名为 `createSession(options: { cwd: string; model?: string; ... })` 形态，则在拿到 `resp.id` 后：

```ts
    if (options.model) {
      this.sessionModels.set(resp.id, options.model);
    }
```

（若签名形态不同，以现状为准做等价记录；不改公开签名。）

3c. 新增私有方法（放在 submitPrompt 之前）：

```ts
  /**
   * 解析 prompt 应携带的 model：session 显式指定 > server /auth default_model。
   * 0.27 忽略 agent_config.model，空 model 的 turn 必败（model.not_configured）；
   * model 有 session 级粘性，恒带幂等且覆盖 server 重启丢粘性的边界。
   */
  private async resolvePromptModel(sessionId: string): Promise<string> {
    const explicit = this.sessionModels.get(sessionId);
    if (explicit) return explicit;
    if (this.serverDefaultModel !== null) return this.serverDefaultModel;
    try {
      const auth = await this.transport.apiGet<{ default_model?: string | null }>("/api/v1/auth");
      this.serverDefaultModel = auth.default_model || "";
    } catch {
      this.serverDefaultModel = "";
    }
    return this.serverDefaultModel;
  }
```

3d. `submitPrompt` body 构建处（约 602-607，`if (autoApprove || ...)` 之后、`apiPost` 之前）插入：

```ts
    const model = await this.resolvePromptModel(sessionId);
    if (model) body.model = model;
```

3e. `sendPrompt` body 构建处（约 644-649，同样位置）插入相同两行。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run build && node --test tests/wire-client-model.test.mjs && node --test tests/wire-client-status.test.mjs && node --test tests/status-normalize.test.mjs`
预期：4 个新用例全过；既有 16 个用例不回归

- [ ] **步骤 5：Commit**

```bash
git add src/wire-client.ts tests/wire-client-model.test.mjs
git commit -m "fix: prompt body 恒带 model——0.27 忽略 agent_config.model 致 turn 必败"
```

**验收标准：**
- [ ] 显式 model（createSession 参数）> server default_model > 省略，三级优先级正确
- [ ] `/auth` 只拉一次；获取失败不阻断提交
- [ ] 4 个新单测全过，既有单测不回归，`npm run build` 零错误

**依赖：** 无（同文件须与任务 8 串行）
**预估规模：** M

---

### 检查点：阶段 2（运行时修复）

- [ ] `node --test tests/` 全部用例通过（20 个）
- [ ] `npm run build` 零错误
- [ ] 任务 7-9 的 commit 均在分支上
- [ ] 与人审查后再继续

---

### 阶段 2：生产链路回归 + 文档回填

### 任务 10：生产链路端到端回归 + 文档修正

**描述：** 用修复后的 tunnel 重跑真实生产链路（即暴露问题的链路），随后把实测新发现回填文档。本任务在 tunnel 部署新版（`npm run build` + 用户 `/reload`）后执行。

**文件：**
- 修改：`API.md`、`docs/issues/web-engine-027-adaptation.md`

- [ ] **步骤 1：生产链路回归（对照检查单逐项验证）**

```
① create_session(cwd, permission_mode="auto")          → 新 session
② execute_prompt(sessionId, 真实只读任务, auto_mode)   → submitted + poll_command
③ Bash(run_in_background=true) 执行 poll_command       → 期望：轮询看到 busy → idle，exit 0，输出真实回复（非空）
④ get_tunnel_status                                    → 期望：wsConnected: true（Fix A 生效）
⑤ 验证期间 server.log                                   → 无 missing_credential 新记录
⑥ execute_prompt 同步路径（wait=true 或第二次调用）      → waitForStatus 经 work_changed 正常解除（Fix B 生效），不等满超时
⑦ 归档测试 session：POST /sessions/{sid}:archive {}
```

- [ ] **步骤 2：API.md 实测修正**

对 `API.md` 做以下精确修改（均来自 2026-07-20 实测）：

1. §1.4 Session 对象结构：把「`last_prompt` 字段已移除」改为「`last_prompt` 保留，并新增 `last_turn_reason`（completed/failed/...）」；删除 ⛔ 标记中的该句，保留 `status` 移除的说明
2. §一 通用约定后新增一条：「**WS 鉴权**：0.27 起 `/api/v1/ws` 升级强制要求 Authorization 头，缺失返回 `missing_credential` 拒绝（0.22.x 容忍无凭据连接）」
3. §2.4 事件表：`event.session.status_changed` 行改为「**0.24+ 不再发送**，由 `event.session.work_changed` 取代」；在表中新增一行：`event.session.work_changed` | 状态变更（0.24+） | `busy`, `main_turn_active`, `pending_interaction`, `last_turn_reason`
4. §1.6 Prompts 补充实测结论：「`agent_config.model` 在 0.27 被静默忽略（创建/profile 更新均无效）；model 必须通过 prompt body 的 `model` 字段传递，且有 session 级粘性（设置一次后续免带）」；响应结构标注改为「已实测」：`{prompt_id, user_message_id, status, content, created_at}`
5. §五 破坏性变更表追加三行：WS 强制鉴权、status_changed→work_changed、agent_config.model 忽略

- [ ] **步骤 3：issue 文档回填**

`docs/issues/web-engine-027-adaptation.md`：§五待验证项全部标注实测结论；新增「生产实测新发现」一节列 Fix A/B/C 三个破坏点及证据；标题状态行视回归结果改 `[DONE]` 或保留 `[OPEN]` 注明剩余项。

- [ ] **步骤 4：Commit**

```bash
git add API.md docs/issues/web-engine-027-adaptation.md
git commit -m "docs: 0.27 生产实测回填——WS 鉴权/work_changed/model 行为 + 端到端回归结论"
```

**验收标准：**
- [ ] 生产链路 7 项检查全部通过（回复非空、wsConnected true、无 missing_credential）
- [ ] API.md 无残留与实测矛盾的描述
- [ ] `npm run build` 零错误

**依赖：** 任务 7-9；**外部依赖：用户 /reload 使新 dist 生效**
**预估规模：** M

---

### 任务 11：CHANGELOG 与迭代收尾

**描述：** CHANGELOG 追加完整适配条目；AGENTS.md 加 0.27 注记；两份计划文档勾选状态收尾。

**文件：**
- 修改：`CHANGELOG.md`、`AGENTS.md`

- [ ] **步骤 1：CHANGELOG 条目**

在 `CHANGELOG.md` 顶部追加（日期以提交日为准）：

```markdown
## 2026-07-20 — Web 引擎 0.24+/0.27 适配（v2.17）

- fix: WS 握手补 Bearer 头——0.27 强制鉴权（missing_credential），修复 wsConnected=false
- fix: 处理 event.session.work_changed——0.24+ 取代 status_changed，状态缓存与 resolver 恢复事件驱动
- fix: prompt body 恒带 model——0.27 静默忽略 agent_config.model 致 turn 必败（model.not_configured）；显式 model > /auth default_model 三级解析
- feat: 状态归一化层（status-normalize.ts）——0.22.x status 枚举与 0.24+ busy/pending_interaction 双模型统一，getSessionStatus 单点接入
- fix: POLL_SCRIPT 双模型判定 + 审批中间态 pending_interaction 补查——消除 SERVER_OFFLINE 误报
- docs: API.md 重写为 0.27.0 实测版（v2 channels、11 项破坏性变更清单）；适配分析与两份实现计划归档
- test: node:test 单测 20 例（归一化/事件映射/model 解析链）；0.27 真实环境生产链路回归通过
```

- [ ] **步骤 2：AGENTS.md 注记**

在 `AGENTS.md` 的「构建与运行 → 前置条件」一节末尾追加一条：

```markdown
5. **Kimi Server 0.24+**：WS 鉴权强制、状态接口为 busy 模型、prompt 必须带 model——tunnel v2.17+ 已适配；低于此版本勿升级 server。详见 API.md §五
```

并在文件头修改记录区顶部追加一行（格式同既有条目）：

```
  2026-07-20 | kimi-code (fix) | v2.17 Web 引擎 0.27 适配：WS Bearer 鉴权 + work_changed 事件 + prompt 恒带 model + 状态归一化层 + POLL_SCRIPT 双模型；API.md 实测重写；20 单测
```

- [ ] **步骤 3：终验 + Commit**

```bash
npm run build && node --test tests/
git add CHANGELOG.md AGENTS.md
git commit -m "docs: v2.17 备案——CHANGELOG + AGENTS.md 0.27 适配注记"
```

**验收标准：**
- [ ] CHANGELOG 条目与实际 commit 一致
- [ ] 构建 + 全部单测终验全绿
- [ ] 分支可评审、可合并

**依赖：** 任务 10
**预估规模：** S

---

### 检查点：完成

- [ ] 全部验收标准满足
- [ ] `npm run build` 零错误，20 个单测全绿
- [ ] 生产链路端到端回归通过
- [ ] 就绪待审查/合并

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `pending_interaction` 的 approval/question 取值为推断 | work_changed 映射错为 idle → 漏审批 | 任务 10 回归时构造 manual session 审批场景实测取值；不符则改 normalizeSessionStatus 一处 |
| prompt 恒带 model 在 0.22.x 上的行为 | 旧 server 是否接受 body.model 未实测 | 旧 API.md 明确记录 prompt body 支持 model 字段；回归时保留一台 0.22.x 验证（或用 isolated 实例） |
| `/auth` default_model 为 null 的部署 | 解析链落空省略 model → 0.27 下 turn 失败 | 兜底为省略（不阻断），失败可见（last_turn_reason=failed + error 事件）；用户可在 create_session 显式传 model |
| work_changed 高频推送 | 每次状态抖动都唤醒 resolver？ | 仅 idle/aborted 清空队列，awaiting_approval 只唤首个，与旧语义一致 |

## 待定问题

- 归档过滤参数名（`?status=archived` 等）实测仍未定（此前隔离实例三种参数均返回空）——任务 10 归档测试 session 后顺手确认并回填 API.md
- `turn.ended` 的 `prompt.completed.reason=failed` 是否需要在 sendPrompt 中显式报错（当前会拉到空回复）——记录为后续增强，不在本迭代
