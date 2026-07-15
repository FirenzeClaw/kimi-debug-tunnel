# Loop Engineering Guide 分层 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Loop Engineering 融入 kimi-session-orchestrator skill 的 guide-driven 体系——新增 `grade_step` MCP 工具、loop 指纹检测、7 个分层 guide。

**架构：** `grade_step` 复用 wireClient.sendPrompt() 做 LLM 评分，loop 指纹从 response.messages 中提取 tool_use 块比对。Guide 采用 Q 分叉树：Q1(A)→entry → Q2(实施/验收)→对应 guide → Q3(单/并行)→终端 guide。

**技术栈：** TypeScript, Zod, MCP SDK, 现有 WireClient

**设计文档：** `docs/superpowers/specs/2026-07-15-loop-engineering-guide-design.md`

---

## 依赖图

```
src/workflow-template.ts           src/tools/grade-step.ts
    (enum +1)                            (新工具)
       │                                     │
       └──── src/workflow-engine.ts ─────────┘
            (指纹检测 +20行)            │
                   │                    │
                   └── src/mcp-server.ts ──┘
                       (注册 +4行)
                            │
                    skills/.../guide-loop-*.md
                       (7 个新文件, ~310行)
                            │
                    skills/.../SKILL.md
                       (Q1 重排 + Q2/Q3 逻辑 +12行)
                            │
                       README.md
                    (安装命令追加)
```

## 任务列表

### 阶段 1：代码基础设施

- [ ] **任务 1：BlockageTypeEnum 扩展**
- [ ] **任务 2：grade_step MCP 工具**
- [ ] **任务 3：Loop 指纹检测**
- [ ] **任务 4：MCP 注册**

### 检查点：代码
- [ ] `npm run build` 零错误
- [ ] `grade_step` 工具可在 MCP 中调用

### 阶段 2：Guide 文件

- [ ] **任务 5：guide-loop-entry.md**
- [ ] **任务 6：guide-loop-implement.md**
- [ ] **任务 7：guide-loop-implement-single.md**
- [ ] **任务 8：guide-loop-implement-parallel.md**
- [ ] **任务 9：guide-loop-verify.md**
- [ ] **任务 10：guide-loop-verify-single.md**
- [ ] **任务 11：guide-loop-verify-parallel.md**

### 检查点：Guide 文件
- [ ] 7 个文件全部存在于 `skills/kimi-session-orchestrator/`
- [ ] 每个 ≤ 50 行
- [ ] 内容符合设计文档 §5 概要

### 阶段 3：Skill 入口

- [ ] **任务 12：SKILL.md 重写 Q1/Q2/Q3 协议**

### 检查点：Skill
- [ ] Q1 含 A/B/C/D 四选项
- [ ] Q2 在 Q1=A 时触发实施/验收选择
- [ ] Q3 在 Q2 后触发单/并行选择
- [ ] 各选项映射到正确 guide 路径

### 阶段 4：部署更新

- [ ] **任务 13：README 安装脚本更新**

---

## 任务详情

### 任务 1：BlockageTypeEnum 扩展

**文件：**
- 修改：`src/workflow-template.ts:6-13`

- [ ] **步骤 1：追加 `loop_detected` 枚举值**

```typescript
export const BlockageTypeEnum = z.enum([
  "dependency_missing",
  "file_not_found",
  "permission_denied",
  "timeout",
  "ambiguous",
  "tool_approval",
  "loop_detected",         // ← 新增
]);
```

- [ ] **步骤 2：构建验证**

运行：`npm run build`
预期：零错误

- [ ] **步骤 3：Commit**

```bash
git add src/workflow-template.ts
git commit -m "feat: BlockageTypeEnum 追加 loop_detected"
```

**依赖：** 无
**预估规模：** XS（1 文件，+1 行）

---

### 任务 2：grade_step MCP 工具

**文件：**
- 创建：`src/tools/grade-step.ts`

- [ ] **步骤 1：创建工具文件**

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";

export function registerGradeStep(server: McpServer, services: TunnelServices): void {
  const { wireClient } = services;

  server.tool(
    "grade_step",
    "对 task session 的产出进行 LLM 自动评分验证。返回 pass/fail 及详细反馈。grader 是筛子非裁判——pass 不代表完美，fail 也不一定是真问题。",
    {
      session_id: z.string().describe("目标 task session ID"),
      criteria: z.string().describe("验收标准，自由文本。逐条明确可量化/可判定的条件"),
      focus: z
        .enum(["completeness", "accuracy", "format"])
        .optional()
        .describe("评分侧重维度：completeness=完整度, accuracy=准确性, format=格式规范"),
    },
    async ({ session_id, criteria, focus }) => {
      if (!wireClient.isConnected()) {
        return { content: [{ type: "text", text: "Wire client 未连接。请先启动 Kimi Server。" }], isError: true };
      }

      const prevSessionId = wireClient.getSessionId();
      const focusHint = focus ? `评分侧重: ${focus}。` : "";

      const gradingPrompt = `你是产出质量评分助手。根据以下验收标准，评估最近一轮 task session 的产出是否合格。
严格仅返回 JSON，不含任何其他文字：{"pass":true|false,"score":0-100,"feedback":"具体原因"}

验收标准：
${criteria}

${focusHint}
请根据 session ${session_id} 的最新产出进行评分。`;

      try {
        wireClient.setSessionId(session_id);
        const response = await wireClient.sendPrompt(gradingPrompt, { timeoutMs: 30000 });
        wireClient.setSessionId(prevSessionId);

        try {
          const parsed = JSON.parse(response.finalText);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                pass: !!parsed.pass,
                score: typeof parsed.score === "number" ? parsed.score : (parsed.pass ? 80 : 30),
                feedback: parsed.feedback || "无反馈",
                session_id,
              }, null, 2),
            }],
          };
        } catch {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                pass: false,
                score: 0,
                feedback: "grader 解析失败，原始响应: " + response.finalText.slice(0, 200),
                session_id,
              }, null, 2),
            }],
          };
        }
      } catch (err) {
        wireClient.setSessionId(prevSessionId);
        return {
          content: [{ type: "text", text: `grade_step 失败: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
```

- [ ] **步骤 2：构建验证**

运行：`npm run build`
预期：零错误

- [ ] **步骤 3：Commit**

```bash
git add src/tools/grade-step.ts
git commit -m "feat: 新增 grade_step MCP 工具 — LLM 自动评分验证"
```

**依赖：** 无
**预估规模：** S（1 文件，~60 行）

---

### 任务 3：Loop 指纹检测

**文件：**
- 修改：`src/workflow-engine.ts`

- [ ] **步骤 1：ActiveExecution 加字段**

在 `interface ActiveExecution`（约 line 104）中追加：
```typescript
interface ActiveExecution {
  // ... existing fields ...
  lastFingerprints: Set<string>;  // ← 新增：上轮工具调用指纹集合
}
```

- [ ] **步骤 2：初始化指纹字段**

在 `execute()` 方法创建 `ActiveExecution` 时（line 266/757）初始化：
```typescript
lastFingerprints: new Set<string>(),
```

- [ ] **步骤 3：driveStep() 中加指纹检测**

在 `driveStep()` 收到 response 后（约 line 385）、blockage 检测之前，插入指纹比对逻辑：

```typescript
// ── Loop fingerprint detection ──
const currentFingerprints = new Set(
  response.messages
    .filter((b: KimiContentBlock) => b.type === "tool_use" && b.tool_name)
    .map((b: KimiContentBlock) => `${b.tool_name}:${JSON.stringify(b.input || {}).slice(0, 80)}`)
);

// Need access to ActiveExecution state — pass via driveStep or store on engine instance
// For now, check against instance-level cache keyed by sessionId
const prevKey = `${sessionId}:${step.id}`;
const prevFingerprints = this._fingerprintCache.get(prevKey);
if (prevFingerprints && currentFingerprints.size > 0) {
  const repeated = [...currentFingerprints].every(f => prevFingerprints.has(f)) &&
                   [...prevFingerprints].every(f => currentFingerprints.has(f));
  if (repeated) {
    this._repeatCount.set(prevKey, (this._repeatCount.get(prevKey) || 0) + 1);
    if ((this._repeatCount.get(prevKey) || 0) >= 3) {
      blockages.push({
        type: "loop_detected",
        context: `同一工具调用模式重复 ${this._repeatCount.get(prevKey)} 次: ${[...currentFingerprints].join(", ")}`,
        resolved: false,
        resolution: "",
        needsUserDecision: true,
      });
      this._repeatCount.delete(prevKey);
      this._fingerprintCache.delete(prevKey);
      // Return blockage immediately
      return {
        stepId: step.id, stepIndex, instruction: step.instruction,
        response: lastResponse, thinkingSummary,
        status: "blocked", adjustment: "", blockages,
      };
    }
  } else {
    this._repeatCount.set(prevKey, 0);
  }
}
this._fingerprintCache.set(prevKey, currentFingerprints);
```

- [ ] **步骤 4：Engine 类加私有缓存**

```typescript
export class WorkflowEngine {
  // ... existing fields ...
  private _fingerprintCache = new Map<string, Set<string>>();
  private _repeatCount = new Map<string, number>();
```

- [ ] **步骤 5：构建验证**

运行：`npm run build`
预期：零错误

- [ ] **步骤 6：Commit**

```bash
git add src/workflow-engine.ts
git commit -m "feat: loop 指纹检测 — 工具调用模式重复 3 次自动 blockage"
```

**依赖：** 任务 1（BlockageTypeEnum 有 `loop_detected`）
**预估规模：** S（1 文件，~40 行新增）

---

### 任务 4：MCP 注册 grade_step

**文件：**
- 修改：`src/mcp-server.ts`

- [ ] **步骤 1：加 import**

在 imports 区域（约 line 24 之后）追加：
```typescript
import { registerGradeStep } from "./tools/grade-step.js";
```

- [ ] **步骤 2：加注册调用**

在 `registerMemoryArchive` 之后（约 line 73）追加：
```typescript
registerGradeStep(server, services);
```

- [ ] **步骤 3：构建验证**

运行：`npm run build`
预期：零错误

- [ ] **步骤 4：Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat: 注册 grade_step 到 MCP server"
```

**依赖：** 任务 2
**预估规模：** XS（1 文件，+4 行）

---

### 任务 5-11：7 个 Guide 文件

**文件：** 全部创建于 `skills/kimi-session-orchestrator/`

每个 guide 按设计文档 §5 的内容概要编写。写法对标 `guide-execute.md`（56 行）风格——紧凑、纯操作指南、引用已有 guide 避免重复。

- [ ] **任务 5：`guide-loop-entry.md`**（~30 行）
  - §一 Loop Engineering 3 句定义
  - §二 实施模式 vs 验收模式
  - §三 接下来 Q2 选择

- [ ] **任务 6：`guide-loop-implement.md`**（~50 行）
  - §一 实施循环模型（5 步流程图）
  - §二 `grade_step` 调用格式 + 返回值 + 边界
  - §三 决策表（pass+抽查/fail+feedback）
  - §四 重试上限 + loop 指纹告警说明
  - §五 衔接 Q3

- [ ] **任务 7：`guide-loop-implement-single.md`**（~40 行）
  - §一 单 session 串行循环说明
  - §二 步骤流水
  - §三 不跳步/不跨步骤重试等约束
  - §四 上下文拐点提醒（引 guide-orchestration.md）

- [ ] **任务 8：`guide-loop-implement-parallel.md`**（~50 行）
  - §一 多 session 并行循环说明
  - §二 并行编排流程
  - §三 grade_step 并行接入
  - §四 汇总决策表
  - §五 并行度上限 5

- [ ] **任务 9：`guide-loop-verify.md`**（~50 行）
  - §一 验收循环模型
  - §二 grade_step 验收模式（criteria 写法建议）
  - §三 验收决策表（全通过/fail 清单/重验）
  - §四 衔接 Q3

- [ ] **任务 10：`guide-loop-verify-single.md`**（~40 行）
  - §一 单 session 串行验收
  - §二 逐条 criteria 流程
  - §三 pass 阈值 + >5 条拆多维度建议

- [ ] **任务 11：`guide-loop-verify-parallel.md`**（~50 行）
  - §一 多维度并行验收说明
  - §二 分派流程（N sessions + 独立 criteria）
  - §三 跨 session 一致性检查 + 调停
  - §四 汇总交付

每个 guide 完成后验证行数 ≤ 50：
```bash
wc -l skills/kimi-session-orchestrator/guide-loop-*.md
```

全部完成后一次性 commit：
```bash
git add skills/kimi-session-orchestrator/guide-loop-*.md
git commit -m "feat: 新增 7 个 Loop Engineering 分层 guide (~310行)"
```

**依赖：** 任务 4（guide 中引用 `grade_step` 工具名）
**预估规模：** M（7 文件，~310 行，但内容独立可并行编写）

---

### 任务 12：SKILL.md 重写 Q1/Q2/Q3 协议

**文件：**
- 修改：`skills/kimi-session-orchestrator/SKILL.md`

- [ ] **步骤 1：Q1 选项重排**

将 line 30-32 的 Q1 选项替换为：

```markdown
- **A: PM 统筹 — Loop Engineering 编排** → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-loop-entry.md`
- **B: PM 统筹 — 规划派发与验收** → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-planning.md`
- **C: PM 统筹 — 长轮次编排验收修复** → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-orchestration.md`
- **D: 执行者** → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-execute.md`
```

同步更新 auto 模式下的纯文本提示（line 20-23）。

- [ ] **步骤 2：Q2 Loop 子问题**

在 Q1 逻辑后追加——仅 Q1=A 时触发：

```markdown
### Loop 子问题（仅 Q1=A 时）

#### Q2 — 循环类型
- **A: 编排自循环 Loop 实施** → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-loop-implement.md`
- **B: 编排自循环 Loop 验收** → 回答后 Read `~/.agents/skills/kimi-session-orchestrator/guide-loop-verify.md`

#### Q3 — 并行度
根据 Q2 回答，加载对应终端 guide：
- **A: 单 task session 串行循环** → Read guide-loop-{implement|verify}-single.md
- **B: 多 session 并行循环** → Read guide-loop-{implement|verify}-parallel.md
```

- [ ] **步骤 3：Commit**

```bash
git add skills/kimi-session-orchestrator/SKILL.md
git commit -m "feat: SKILL.md Q1 重排 — Loop Engineering 为 A 入口 + Q2/Q3 子问题树"
```

**依赖：** 任务 5-11（所有 guide 文件已存在）
**预估规模：** XS（1 文件，~15 行改动）

---

### 任务 13：README 安装脚本更新

**文件：**
- 修改：`README.md`

- [ ] **步骤 1：安装脚本追加 guide 复制命令**

在 skill 安装命令块的 Agent 级 skill 部分（约 line 174-186）追加：

```bash
cp skills/kimi-session-orchestrator/guide-loop-*.md ~/.agents/skills/kimi-session-orchestrator/
```

- [ ] **步骤 2：更新工具章节**

如需列出 `grade_step` 工具，在 MCP 工具表中追加一行。当前 README 工具分类不包含"验证"类——可加在"权限策略"后面。

- [ ] **步骤 3：Commit**

```bash
git add README.md
git commit -m "docs: README 追加 Loop Engineering guide 安装命令"
```

**依赖：** 任务 12
**预估规模：** XS（1 文件，~3 行）

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `grade_step` 在 grader session 中 sendPrompt 超时 | 中 — 工具返回 error | timeoutMs=30s，超时后 catch 返回友好错误；grader session 懒创建复用 |
| loop 指纹误判（不同 args 但哈希碰撞） | 低 — 极少发生 | 使用完整 args JSON 前 80 字符，碰撞概率极低；3 次重复才触发 |
| guide 文件行数超标 | 低 — 内容概要已精确 | 每个 guide 编写后 wc -l 验证；超 50 行则拆分或精简 |
| SKILL.md Q 分叉逻辑复杂度过高 | 低 — 3 层分叉 | Q1 统一处理，Q2/Q3 仅 A 分支触发；保持 auto/non-auto 双模式一致 |

## 待定问题

- 无——所有决策已于设计阶段确认
