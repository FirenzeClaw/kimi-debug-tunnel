# Web 引擎 0.24.x/0.27.0 适配实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 kimi-session-orchestrator 在 Kimi Server 0.24+（busy/pending_interaction 状态模型）下保持全部现有功能，同时兼容 0.22.x（status 枚举模型）。

**架构：** 在 `getSessionStatus()` 单点新增状态归一化层，把 0.24+ 的 `busy`/`pending_interaction` 三元组映射回内部沿用词表（`idle/running/awaiting_approval/awaiting_question`），上层（waitForStatus / session-watcher / tools）零改动；POLL_SCRIPT 内嵌同样的鸭式判定。通过 duck-typing（`status` 字段存在与否）识别新旧模型，不解析版本号。

**技术栈：** TypeScript 5.6（strict）、Node ≥22（内置 `node:test` 做单元测试）、Python ≥3.7（轮询脚本）

**分支：** `feat/web-engine-0.27-adaptation`（已创建）

**依据文档：** `API.md`（0.27.0 实测重写版）、`docs/issues/web-engine-027-adaptation.md`（影响面分析）

---

## 文件清单

| 文件 | 职责 | 动作 |
|------|------|------|
| `src/status-normalize.ts` | 状态归一化纯函数（新模块，唯一新增文件） | 创建 |
| `src/wire-client.ts:706-721` | `getSessionStatus()` 接入归一化 + 二级取数 | 修改 |
| `src/poll-command.ts:112-124` | POLL_SCRIPT 状态判定改鸭式双模型 | 修改 |
| `tests/status-normalize.test.mjs` | 归一化函数单元测试（node:test，打 dist 产物） | 创建 |
| `AGENTS.md`（审批工作流 curl 示例） | 补 `?status=pending` | 修改 |
| `docs/issues/web-engine-027-adaptation.md` | 状态 OPEN → 逐项标记 | 修改 |

---

## 任务列表

### 阶段 1：状态归一化核心（P0）

---

### 任务 1：status-normalize 纯函数模块 + 单元测试

**描述：** 新建 `src/status-normalize.ts`，导出 `normalizeSessionStatus()` 纯函数，把两种服务端状态模型统一映射到内部词表。配套 `node:test` 单元测试覆盖全部映射分支。纯函数无网络依赖，可独立验证。

**文件：**
- 创建：`src/status-normalize.ts`
- 测试：`tests/status-normalize.test.mjs`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/status-normalize.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionStatus } from "../dist/status-normalize.js";

// ── 旧模型（0.22.x）：status 字段优先，原样透传 ──
test("legacy: status enum passthrough", () => {
  assert.equal(normalizeSessionStatus({ status: "idle" }), "idle");
  assert.equal(normalizeSessionStatus({ status: "running" }), "running");
  assert.equal(normalizeSessionStatus({ status: "awaiting_approval" }), "awaiting_approval");
  assert.equal(normalizeSessionStatus({ status: "aborted" }), "aborted");
});

// ── 新模型（0.24+）：busy=true → running ──
test("busy model: busy=true → running", () => {
  assert.equal(normalizeSessionStatus({ busy: true }), "running");
  assert.equal(
    normalizeSessionStatus({ busy: true }, { pending_interaction: "approval" }),
    "running"
  );
});

// ── 新模型（0.24+）：busy=false → 看 pending_interaction ──
test("busy model: busy=false + no detail → idle", () => {
  assert.equal(normalizeSessionStatus({ busy: false }), "idle");
});
test("busy model: busy=false + pending_interaction=none → idle", () => {
  assert.equal(
    normalizeSessionStatus({ busy: false }, { pending_interaction: "none" }),
    "idle"
  );
});
test("busy model: busy=false + approval → awaiting_approval", () => {
  assert.equal(
    normalizeSessionStatus({ busy: false }, { pending_interaction: "approval" }),
    "awaiting_approval"
  );
});
test("busy model: busy=false + question → awaiting_question", () => {
  assert.equal(
    normalizeSessionStatus({ busy: false }, { pending_interaction: "question" }),
    "awaiting_question"
  );
});

// ── 边界：两模型字段都缺失 → unknown（不误判） ──
test("edge: empty body → unknown", () => {
  assert.equal(normalizeSessionStatus({}), "unknown");
  assert.equal(normalizeSessionStatus({ status: "" }), "unknown");
});

// ── 边界：status 与 busy 同时存在时 status 优先（前向兼容） ──
test("edge: status wins over busy", () => {
  assert.equal(normalizeSessionStatus({ status: "idle", busy: true }), "idle");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run build && node --test tests/status-normalize.test.mjs`
预期：FAIL，报错 `Cannot find module '../dist/status-normalize.js'`

- [ ] **步骤 3：编写实现**

创建 `src/status-normalize.ts`：

```ts
/**
 * Session 状态归一化：统一 0.22.x（status 枚举）与 0.24+（busy/pending_interaction
 * 三元组）两种服务端模型到内部沿用词表。
 *
 * 内部词表: idle | running | awaiting_approval | awaiting_question | aborted | unknown
 * 映射规则（0.27.0 实测，见 API.md §五）:
 *   busy=true                     → running
 *   busy=false + approval         → awaiting_approval
 *   busy=false + question         → awaiting_question
 *   busy=false + none/无详情       → idle
 * 两模型字段均缺失                → unknown（不误判为 offline/idle）
 * status 与 busy 同时存在          → status 优先（前向兼容）
 *
 * 注意: 0.24+ 无 aborted 等价字段；中止由 turn.ended 事件承载，REST 侧按 idle 处理。
 */

/** GET /api/v1/sessions/{id}/status 响应体（两种模型的并集） */
export interface StatusEndpointBody {
  status?: string; // 0.22.x 枚举模型
  busy?: boolean; // 0.24+ busy 模型
  [key: string]: unknown;
}

/** GET /api/v1/sessions/{id} 响应体的相关子集 */
export interface SessionDetailBody {
  status?: string; // 0.22.x
  busy?: boolean; // 0.24+
  pending_interaction?: string; // 0.24+: none | approval | question（后两者为推断值）
  [key: string]: unknown;
}

export function normalizeSessionStatus(
  statusBody: StatusEndpointBody,
  sessionBody?: SessionDetailBody
): string {
  // 旧模型优先：0.22.x 直接给出枚举值
  if (typeof statusBody.status === "string" && statusBody.status) {
    return statusBody.status;
  }
  // 新模型：busy 判定
  if (statusBody.busy === true) return "running";
  if (statusBody.busy === false) {
    const pending = sessionBody?.pending_interaction;
    if (pending === "approval") return "awaiting_approval";
    if (pending === "question") return "awaiting_question";
    return "idle";
  }
  return "unknown";
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run build && node --test tests/status-normalize.test.mjs`
预期：PASS，9 个测试全绿

- [ ] **步骤 5：Commit**

```bash
git add src/status-normalize.ts tests/status-normalize.test.mjs
git commit -m "feat: status 归一化层——兼容 0.22.x 枚举与 0.24+ busy 双模型"
```

**验收标准：**
- [ ] `normalizeSessionStatus` 覆盖 idle/running/awaiting_approval/awaiting_question/unknown 全部映射分支
- [ ] 空响应体返回 `unknown` 而非 `idle`（防 poll 链路误判 offline 的回归）
- [ ] `npm run build` 零错误，9 个单测全过

**依赖：** 无
**预估规模：** S

---

### 任务 2：wire-client getSessionStatus 接入归一化

**描述：** 修改 `getSessionStatus()` REST 兜底路径：调 `/status` 后若为旧模型直接返回；若为新模型且 `busy==false`，补一次 `GET /sessions/{id}` 取 `pending_interaction` 以区分 idle 与 awaiting_*。WS 缓存快路径不动。

**文件：**
- 修改：`src/wire-client.ts:706-721`

- [ ] **步骤 1：修改 import**

`src/wire-client.ts` 顶部 import 区追加：

```ts
import {
  normalizeSessionStatus,
  type StatusEndpointBody,
  type SessionDetailBody,
} from "./status-normalize.js";
```

- [ ] **步骤 2：替换 getSessionStatus 方法体**

将 `src/wire-client.ts:706-721` 整个方法替换为：

```ts
  async getSessionStatus(sessionId: string): Promise<string> {
    // Fast path: WebSocket cache
    const cached = this.sessionStateCache.get(sessionId);
    if (cached && Date.now() - cached.updatedAt < 30000) {
      return cached.status;
    }
    // Fallback: REST API（双模型兼容，0.24+ 见 status-normalize.ts）
    try {
      const statusBody = await this.transport.apiGet<StatusEndpointBody>(
        `/api/v1/sessions/${sessionId}/status`
      );
      // 0.24+ busy 模型下 busy==false 时，/status 不含 pending_interaction，
      // 需补取 session 详情区分 idle 与 awaiting_approval/awaiting_question
      let sessionBody: SessionDetailBody | undefined;
      if (statusBody.status === undefined && statusBody.busy === false) {
        sessionBody = await this.transport.apiGet<SessionDetailBody>(
          `/api/v1/sessions/${sessionId}`
        );
      }
      return normalizeSessionStatus(statusBody, sessionBody);
    } catch {
      return "unknown";
    }
  }
```

- [ ] **步骤 3：构建 + 回归单测**

运行：`npm run build && node --test tests/status-normalize.test.mjs`
预期：构建零错误；单测不受影响全过

- [ ] **步骤 4：Commit**

```bash
git add src/wire-client.ts
git commit -m "feat: getSessionStatus 接入状态归一化，0.24+ 补取 pending_interaction"
```

**验收标准：**
- [ ] 0.22.x server 下行为与现状完全一致（`status` 字段直通，只有一次 `/status` 请求）
- [ ] 0.24+ server 下 `busy==true` 返回 `running`，`busy==false` 按 `pending_interaction` 返回 `idle`/`awaiting_approval`/`awaiting_question`
- [ ] 仅在新模型且空闲时多发一次详情请求；WS 缓存路径零改动
- [ ] `npm run build` 零错误

**依赖：** 任务 1
**预估规模：** S

---

### 任务 3：POLL_SCRIPT 双模型状态判定

**描述：** 修改 `src/poll-command.ts` 内嵌 Python 脚本的状态解析：`status` 字段优先（旧模型），否则按 `busy` 布尔推导。空判定逻辑（`if not status` → 计失败）保持不变——新模型下 busy=False 会给出 'idle'，busy 字段整体缺失才计失败，语义与旧版一致。`~/.kimi-tunnel/poll.py` 由 execute-prompt/chat-with-session 每次调用时重写，改 POLL_SCRIPT 即自动生效，无需手动部署。

**文件：**
- 修改：`src/poll-command.ts:112-124`

- [ ] **步骤 1：替换 POLL_SCRIPT 状态解析段**

将 `src/poll-command.ts:119-122`：

```ts
  "        sdata = d.get('data', {})",
  "        status = sdata.get('status', '')",
  "        ctx_tokens = sdata.get('context_tokens', '')",
  "        ctx_max = sdata.get('max_context_tokens', '')",
```

替换为：

```ts
  "        sdata = d.get('data', {})",
  "        # 双模型兼容: 0.22.x status 枚举优先; 0.24+ 按 busy 推导（见 API.md §五）",
  "        if sdata.get('status'):",
  "            status = sdata['status']",
  "        elif sdata.get('busy') is True:",
  "            status = 'running'",
  "        elif sdata.get('busy') is False:",
  "            status = 'idle'",
  "        ctx_tokens = sdata.get('context_tokens', '')",
  "        ctx_max = sdata.get('max_context_tokens', '')",
```

- [ ] **步骤 2：构建**

运行：`npm run build`
预期：零错误

- [ ] **步骤 3：生成脚本做 Python 语法自检**

运行：

```bash
node -e "const {POLL_SCRIPT}=require('./dist/poll-command.js');require('fs').writeFileSync('/tmp/poll-check.py',POLL_SCRIPT)"
python3 -c "import py_compile; py_compile.compile('/tmp/poll-check.py', doraise=True)" || python -c "import py_compile; py_compile.compile('/tmp/poll-check.py', doraise=True)"
```

预期：无输出退出码 0（语法合法）

- [ ] **步骤 4：对 0.27 隔离实例做端到端冒烟**

```bash
# 4.1 起隔离实例（不干扰现有 server）
mkdir -p /tmp/kimi-test-home
KIMI_CODE_HOME=/tmp/kimi-test-home kimi web --no-open --port 55829 --keep-alive &

# 4.2 建 session（记录返回的 sid 与启动日志中的 token）
TOKEN=<启动日志中的 token>
SID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"poll-smoke","metadata":{"cwd":"D:/code/kimi-session-orchestrator"}}' \
  http://127.0.0.1:55829/api/v1/sessions | python -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")

# 4.3 用新脚本轮询该空闲 session——应立即判 idle → fetch_result → exit 0
node -e "const {POLL_SCRIPT}=require('./dist/poll-command.js');require('fs').writeFileSync('/tmp/poll-smoke.py',POLL_SCRIPT)"
PYTHONIOENCODING=utf-8 python3 /tmp/poll-smoke.py "$SID" "http://127.0.0.1:55829" "$TOKEN" 30 3
echo "exit=$?"   # 预期 exit=0（idle 立即命中，消息为空则只打印分隔符）

# 4.4 收尾：关停隔离实例
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:55829/api/v1/shutdown
```

预期：`exit=0`，且**不**出现 `[SERVER_OFFLINE]`（0.22.3 脚本在 0.27 下的故障特征）

- [ ] **步骤 5：对旧 server（0.22.3，端口 58627）回归冒烟**

```bash
# 用运行中的 0.22.3 server 上一个真实 session 验证旧模型路径不受影响
TOKEN=$(cat ~/.kimi-code/server.token)
SID=<任一 0.22.3 session id，用 curl .../api/v1/sessions 取>
PYTHONIOENCODING=utf-8 python3 /tmp/poll-smoke.py "$SID" "http://127.0.0.1:58627" "$TOKEN" 30 3
echo "exit=$?"   # 预期 exit=0（idle 直通）
```

- [ ] **步骤 6：Commit**

```bash
git add src/poll-command.ts
git commit -m "fix: POLL_SCRIPT 状态判定兼容 0.24+ busy 模型，消除 SERVER_OFFLINE 误报"
```

**验收标准：**
- [ ] 0.27 实例空闲 session：脚本判 `idle` 并 exit 0（旧脚本在此场景 exit 2 误报）
- [ ] 0.22.3 实例：行为与现状一致
- [ ] `busy` 字段整体缺失（真离线/异常响应）仍计入失败 → 保留 SERVER_OFFLINE 检出能力
- [ ] Python 语法自检通过；`npm run build` 零错误

**依赖：** 任务 1（词表一致）
**预估规模：** M

---

### 检查点：阶段 1（P0 核心）

- [ ] `node --test tests/status-normalize.test.mjs` 全过
- [ ] `npm run build` 零错误
- [ ] 0.27 隔离实例上 poll 冒烟 exit 0；0.22.3 回归 exit 0
- [ ] 三个 commit 均在 `feat/web-engine-0.27-adaptation` 分支上
- [ ] 与人审查后再继续

---

### 阶段 2：运行中验证（P1）

### 任务 4：真实 0.27 环境验证 WS 事件载荷与 prompt 响应结构

**描述：** 分析阶段有 5 项只能带 provider 实测（`docs/issues/web-engine-027-adaptation.md` §五）。本任务在用户的真实 0.27 server（升级后）上验证，并按结果决定 `handleDirectEvent` 是否需要改。这是**人工协作任务**：需要用户升级 server 并提供窗口。

**文件：**
- 视结果修改：`src/wire-client.ts:388-450`（handleDirectEvent）
- 修改：`docs/issues/web-engine-027-adaptation.md`（验证项逐个打勾）

- [ ] **步骤 1：确认前置**

用户已将日常 server 升级到 0.24+（`kimi web --no-open` 重启即自动用新版二进制），tunnel `npm start` 连接成功。

- [ ] **步骤 2：验证 status_changed 事件载荷**

```bash
# tunnel 运行中，创建一个 auto 测试 session 并提交一条简单 prompt（如“回复 ok”）
# 观察 tunnel stderr（[wire-client] 日志）与状态缓存：
#   - turn.started / turn.ended 是否到达
#   - event.session.status_changed 的 payload 是否仍含 status 枚举字段
```

判定：
- 若 `payload.status` 保留 → `handleDirectEvent` **无需改**，任务直接进步骤 4
- 若已变为 busy/pending_interaction 形态 → 执行步骤 3

- [ ] **步骤 3：（条件分支）修 handleDirectEvent 事件映射**

仅当步骤 2 判定事件载荷已变时执行。在 `src/wire-client.ts:396` 的分支旁新增并行分支（保留旧分支兼容 0.22.x）：

```ts
    // 0.24+ 事件模型（条件触发：status_changed 载荷无 status 字段时）
    if (type === "event.session.status_changed" && !payload?.status && payload?.busy !== undefined) {
      const mapped = normalizeSessionStatus(
        { busy: payload.busy as boolean },
        { pending_interaction: payload.pending_interaction as string | undefined }
      );
      cached.status = mapped;
      cached.updatedAt = Date.now();
      this.sessionStateCache.set(sessionId, cached);
      const resolvers = this.statusResolvers.get(sessionId);
      if (resolvers && resolvers.length > 0) {
        if (mapped === "idle" || mapped === "aborted") {
          for (const r of resolvers) r.resolve(mapped);
          this.statusResolvers.delete(sessionId);
        } else if (mapped === "awaiting_approval") {
          const resolver = resolvers[0];
          if (resolver) resolver.resolve("awaiting_approval");
        }
      }
    }
```

修改后运行 `npm run build` 并重复步骤 2 验证 resolver 能正常解除等待。

- [ ] **步骤 4：验证 POST /prompts 成功响应结构**

```bash
# 真实 server 上提交 prompt 成功响应中确认 prompt_id / user_message_id 字段存在
# （tunnel 日志或 curl 手动提交均可）
```

若字段缺失/改名 → 同步修 `wire-client.ts:650-657` 的类型与取值，并更新 API.md。

- [ ] **步骤 5：验证 pending_interaction 枚举与 sessions 归档过滤参数**

```bash
# manual session 触发一次工具审批 → GET /sessions/{id} 看 pending_interaction 实际值
# curl ".../api/v1/sessions?status=archived" 等参数名逐个试，确认归档过滤参数
```

结果回填 API.md 对应 ⚠️ 标注（消除推断标记）。

- [ ] **步骤 6：文档收尾 + Commit**

`docs/issues/web-engine-027-adaptation.md` §五 五项逐条标注实测结果；API.md 消除对应 ⚠️。

```bash
git add src/wire-client.ts API.md docs/issues/web-engine-027-adaptation.md
git commit -m "fix: 0.27 实测验证——事件载荷/prompt 响应/枚举值回填（按实测结果）"
```

**验收标准：**
- [ ] §五 5 个待验证项全部有实测结论（文档中消除 ⚠️）
- [ ] auto session 提交 prompt → waitForStatus 正常解除 → 拉到回复（端到端通）
- [ ] `npm run build` 零错误

**依赖：** 任务 2、3；**外部依赖：用户升级真实 server 到 0.24+**
**预估规模：** M

---

### 阶段 3：文档与收尾（P2）

### 任务 5：AGENTS.md / skill 文档同步

**描述：** 审批工作流的 curl 示例补 `?status=pending`；涉及状态枚举描述的段落加注 0.24+ 映射规则。skills 目录下涉及 `data.status` 的指南同步。

**文件：**
- 修改：`AGENTS.md`（标准工作流 → 审批工作流一节）
- 修改：`skills/kimi-session-orchestrator/` 下涉及状态判定的 guide（先 grep 定位）

- [ ] **步骤 1：定位所有过时描述**

```bash
grep -rn "awaiting_approval\|/status\|status=pending" AGENTS.md skills/ --include="*.md" -l
```

逐个文件确认：curl 示例是否带 `?status=pending`；状态枚举描述是否需要加 0.24+ 注记。

- [ ] **步骤 2：AGENTS.md 审批工作流示例修正**

将审批监听示例中的：

```bash
     if [ "$STATUS" = "awaiting_approval" ]; then
       curl .../approvals?status=pending | jq  # 查看待审批工具
```

确认 `?status=pending` 已带（若已带则该行无需改）；在其上方状态判定注释追加一行说明：

```bash
     # 注意: 0.24+ server 的 /status 返回 {busy,...} 而非 {status}
     # 经 tunnel getSessionStatus 归一化后词表不变（busy=false→idle 等，见 API.md §五）
```

skills 下 guide 做同类最小注记（每处一两行，不重写段落）。

- [ ] **步骤 3：Commit**

```bash
git add AGENTS.md skills/
git commit -m "docs: 状态模型双轨注记 + approvals 查询参数核对"
```

**验收标准：**
- [ ] grep 命中的状态相关文档全部过一遍，无遗漏的过时枚举假设
- [ ] 修改均为注记级，不改写既有流程描述

**依赖：** 任务 2（词表与映射规则定稿）
**预估规模：** S

---

### 任务 6：变更记录与分支收尾

**描述：** CHANGELOG.md 追加本次适配条目；`docs/issues/web-engine-027-adaptation.md` 状态从 OPEN 改为 DONE（任务 4 的验证项若未完成则保持 OPEN 并注明）；向用户交付合并建议。

**文件：**
- 修改：`CHANGELOG.md`
- 修改：`docs/issues/web-engine-027-adaptation.md`（标题状态行）

- [ ] **步骤 1：CHANGELOG 条目**

在 `CHANGELOG.md` 顶部追加（日期以实际提交日为准）：

```markdown
## 2026-07-2x — Web 引擎 0.24+ 适配

- feat: 状态归一化层（status-normalize.ts）——0.22.x status 枚举与 0.24+ busy/pending_interaction 双模型统一映射，getSessionStatus 单点接入，上层零改动
- fix: POLL_SCRIPT 状态判定兼容 busy 模型——消除 0.24+ 下 SERVER_OFFLINE 误报（exit 2）
- docs: API.md 重写为 0.27.0 实测版（v2 channels、破坏性变更清单）；AGENTS/skills 状态描述双轨注记
- 分析: docs/issues/web-engine-027-adaptation.md（影响面 + 5 项运行中验证）
```

- [ ] **步骤 2：issue 状态更新**

`docs/issues/web-engine-027-adaptation.md` 标题行 `[OPEN]` 改为 `[DONE]`（若任务 4 因 server 未升级而搁置，则改 `[PARTIAL]` 并在 §五标注阻塞原因）。

- [ ] **步骤 3：构建终验 + Commit**

```bash
npm run build && node --test tests/status-normalize.test.mjs
git add CHANGELOG.md docs/issues/web-engine-027-adaptation.md
git commit -m "docs: 0.24+ 适配备案——CHANGELOG + issue 状态收尾"
```

**验收标准：**
- [ ] CHANGELOG 条目与实际 commit 内容一致
- [ ] 构建 + 单测终验全绿
- [ ] 分支可评审、可合并

**依赖：** 任务 1-5
**预估规模：** XS

---

### 检查点：完成

- [ ] 全部验收标准满足（任务 4 若被外部依赖阻塞，分支以 PARTIAL 交付并明确剩余项）
- [ ] `npm run build` 零错误，单测全绿
- [ ] 就绪待审查/合并

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `pending_interaction` 枚举值（approval/question）为推断，实测可能是别的拼写 | awaiting_* 误判为 idle → PM 漏审批 | 归一化层只认精确值、其余落 idle；任务 4 实测后立即校正；poll 链路不依赖该枚举（只看 busy），高危路径不受影响 |
| 0.24+ 无 `aborted` 等价字段 | 中止的 turn 被当 idle → 提前拉消息 | 中止场景消息本就完整度低，fetch_result 拿到什么算什么（与现状一致）；turn.ended reason 可作未来增强 |
| 新模型下 busy==false 多发一次详情请求 | REST 兜底路径延迟 +1 RTT | 仅兜底路径（WS 缓存 30s 快路径不变）；轮询场景 1s 间隔可接受 |
| 任务 4 依赖用户升级真实 server | 验证项无法在本分支闭环 | 分支可先以 P0+文档交付（PARTIAL），任务 4 单独跟进 |
| handleDirectEvent 条件分支（步骤 3）可能根本不需要 | 死代码风险 | 仅在实测确认事件载荷已变时才合入该分支；否则任务 4 只改文档 |

## 待定问题

- 用户计划何时把日常 server 从 0.22.3 升级到 0.24+？（决定任务 4 排期；升级前本分支在 0.22.3 下必须完全无回归——任务 1-3 的验收已覆盖）
- `aborted` 是否需要精确信号？（现状 poll/等候逻辑把 aborted 当终止态拉消息即可，若要区分需看 snapshot.in_flight_turn / turn.ended reason）
