# 上下文长度 Bash 监控 + Session 规范统一 — 实现计划

> **面向 AI 代理的工作者：** 步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** bash 后台轮询完成时自动检查 context_tokens，>36K 输出 `[CTX_HIGH]` 提醒；将逐条注入/session 复用/context_tokens 监控三条铁律收束到两个 SKILL.md 入口。

**架构：** 纯 bash 增强（`poll-command.ts` 扩展 `parse_context` + idle 分支判断），零 WS/TS 架构改动。SKILL.md 为规范权威入口，sub-guide 移除重复声明仅保留引用。

**技术栈：** TypeScript（poll-command.ts）、Markdown（skill/guide 文件）、bash

---

## 依赖图

```
spec/design doc（已确认）
    │
    ├── Task 1: poll-command.ts（独立，无依赖）
    │
    ├── Task 2: kimi-session-orchestrator SKILL.md（独立）
    ├── Task 3: loop-orchestrator SKILL.md（独立）
    │
    ├── Task 4: guide-orchestration.md（独立）
    ├── Task 5: guide-planning.md（独立）
    ├── Task 6: guide-loop-injection.md（独立）
    ├── Task 7: guide-loop-core.md（独立）
    │
    └── Task 8: Build + verify（依赖 Task 1）
        └── Task 9: Deploy skills（依赖 Task 2-7）
```

任务 1-7 可安全并行（零共享状态），任务 2-7 之间也可并行。

---

## 任务列表

### 阶段 1：核心代码

### 任务 1：`poll-command.ts` — bash 上下文监控

**描述：** 新增 `parse_context()` 函数从 `/status` 端点提取 `context_tokens`/`max_context_tokens`；修改 idle/aborted 分支在 fetch_result 前检查是否超 36K。

**文件：**
- 修改：`src/poll-command.ts:49-106`

**验收标准：**
- [ ] `parse_context()` 函数存在于生成的 bash 脚本中
- [ ] idle/aborted 分支在 `echo "---RESULT---"` 之前包含 `[CTX_HIGH]` 检查
- [ ] `context_tokens > 36000` 时输出 `[CTX_HIGH] N / M tokens — 建议 PM 评估退役`
- [ ] `context_tokens ≤ 36000` 或解析失败时不输出 `[CTX_HIGH]`

**步骤：**

- [ ] **步骤 1：在 `parse_status()` 之后添加 `parse_context()` 函数**

在 `poll-command.ts` 第 52-53 行之间（`parse_status` 结束和 `fetch_result` 开始之间）插入：

```typescript
    `parse_context() {`,
    `  curl -s --max-time 10 ${authHeader} "$BASE/api/v1/sessions/$SID/status" | \\`,
    `    $PY -c "import sys,json; d=json.load(sys.stdin).get('data',{}); print(d.get('context_tokens',''),d.get('max_context_tokens',''))"`,
    `}`,
    ``,
```

即在第 52 行 `\`}\`,` 之后、第 53 行 `\`fetch_result() {\`,` 之前插入 5 行。

- [ ] **步骤 2：修改 idle/aborted 分支（第 98-102 行）**

将当前：
```typescript
    `  if [ "$STATUS" = "idle" ] || [ "$STATUS" = "aborted" ]; then`,
    `    echo "---RESULT---"`,
    `    fetch_result`,
    `    exit 0`,
    `  fi`,
```

替换为：
```typescript
    `  if [ "$STATUS" = "idle" ] || [ "$STATUS" = "aborted" ]; then`,
    `    # Context length check (v2.14)`,
    `    CTX_INFO=$(parse_context)`,
    `    CTX_TOKENS=$(echo "$CTX_INFO" | awk '{print $1}')`,
    `    CTX_MAX=$(echo "$CTX_INFO" | awk '{print $2}')`,
    `    if [ -n "$CTX_TOKENS" ] && [ "$CTX_TOKENS" -gt 36000 ] 2>/dev/null; then`,
    `      echo "[CTX_HIGH] $CTX_TOKENS / ${CTX_MAX:-?} tokens — 建议 PM 评估退役"`,
    `    fi`,
    `    echo "---RESULT---"`,
    `    fetch_result`,
    `    exit 0`,
    `  fi`,
```

- [ ] **步骤 3：TSC 编译验证**

```bash
npm run build
```
预期：编译成功，无类型错误。

- [ ] **步骤 4：验证生成的 bash 脚本包含 parse_context**

```bash
node -e "
const { generatePollCommand } = require('./dist/poll-command.js');
const cmd = generatePollCommand({ sessionId: 'test', token: 'test' });
console.log(cmd.includes('parse_context()') ? 'PASS: parse_context present' : 'FAIL');
console.log(cmd.includes('[CTX_HIGH]') ? 'PASS: CTX_HIGH present' : 'FAIL');
console.log(cmd.includes('36000') ? 'PASS: threshold present' : 'FAIL');
"
```
预期：全部 PASS。

---

### 阶段 2：SKILL.md 入口统一

### 任务 2：`kimi-session-orchestrator/SKILL.md` — 关键约束追加

**描述：** 在"关键约束"列表末尾追加 3 条规则（逐条注入、session 复用优先、context_tokens 监控）。

**文件：**
- 修改：`skills/kimi-session-orchestrator/SKILL.md:83`

**步骤：**

- [ ] **步骤 1：在第 83 行后追加 3 条约束**

在 `5. **create_session 的 permission_mode="auto" 是 session 级别** — ...` 之后、`---` 之前插入：

```markdown
6. **⛔ 逐条注入** — 每次 execute_prompt 只含一个操作指令；等 task session 完成
   → PM 审查 → 再发下一步。严禁一条 prompt 包多个操作。
7. **⛔ Session 复用优先** — 同模块连续工作同 session 继续；新建仅限：上下文超限 /
   产出质量下降 / 模块切换。
8. **context_tokens 监控**（v2.14）— bash 轮询完成时自动检查；> 36K 输出
   `[CTX_HIGH]` 提醒退役。
```

- [ ] **步骤 2：验证**

```bash
grep -c "逐条注入" skills/kimi-session-orchestrator/SKILL.md
grep -c "Session 复用优先" skills/kimi-session-orchestrator/SKILL.md
grep -c "context_tokens 监控" skills/kimi-session-orchestrator/SKILL.md
```
预期：每行输出 `1`。

---

### 任务 3：`loop-orchestrator/SKILL.md` — 核心铁律更新

**描述：** 更新铁律表（"一个 execute_prompt 一个目标" → "逐条注入"、补充 context_tokens 阈值）；自检清单追加 context_tokens 检查项。

**文件：**
- 修改：`skills/loop-orchestrator/SKILL.md:84-86, 94`

**步骤：**

- [ ] **步骤 1：替换铁律表第 84-86 行**

当前：
```
| 一个 execute_prompt 一个目标 | 多目标合一 → 注意力腐化 |
| 跨模块必须分 session | 上下文污染 |
| session 复用优先 | grade_step / 修复同 session 继续 |
```

替换为：
```
| ⛔ 逐条注入（一次一个操作指令） | 多操作合一 → 注意力稀释、PM 无法定位错误 |
| 跨模块必须分 session | 上下文污染 |
| session 复用优先 | 新建仅限：context_tokens > 36K / 质量下降 / 模块切换 |
```

- [ ] **步骤 2：自检清单追加第 5 项**

在第 94 行（自检清单第 4 项之后）追加：

```
| 5 | Bash 通知含 `[CTX_HIGH]`？ | 是 → 评估退役；否 → 继续 |
```

- [ ] **步骤 3：验证**

```bash
grep "逐条注入（一次一个操作指令）" skills/loop-orchestrator/SKILL.md
grep "context_tokens > 36K" skills/loop-orchestrator/SKILL.md
grep "CTX_HIGH" skills/loop-orchestrator/SKILL.md
```
预期：每行命中一次。

---

### 阶段 3：Sub-guide 冗余清扫

### 任务 4：`guide-orchestration.md` — §二压缩 + §五阈值更新

**描述：** 移除 §二中的规则声明（改为引用 SKILL.md），保留操作示例；§五退役阈值从 proxy 指标更新为 `context_tokens`。

**文件：**
- 修改：`skills/kimi-session-orchestrator/guide-orchestration.md`

**步骤：**

- [ ] **步骤 1：§二标题 + 声明行替换（第 14-18 行）**

将：
```markdown
## 二、一次性一指令原则（⛔ 核心铁律）

**任务注入必须逐级进行，严禁一次性全注入。**

每个 `execute_prompt` 只含**一个操作**。等待 task session 完成并返回结果 → PM 审查通过 → 再发送下一步。
```

替换为：
```markdown
## 二、逐条注入操作示例

> ⛔ 铁律见 SKILL.md §关键约束 第6条。以下为 7 步管线中的实际操作范例。

每个 `execute_prompt` 只含**一个操作**。等待 task session 完成并返回结果 → PM 审查通过 → 再发送下一步。
```

- [ ] **步骤 2：§五退役阈值表第 226 行更新**

将：
```
| 上下文预估 ~300K（wire.jsonl ~80 行 / ~10-12 轮） | **主动评估退役** |
```
替换为：
```
| context_tokens > 36K（bash 通知 [CTX_HIGH]） | **主动评估退役**（v2.14 首选指标） |
```

- [ ] **步骤 3：验证**

```bash
grep "铁律见 SKILL.md" skills/kimi-session-orchestrator/guide-orchestration.md
grep "context_tokens > 36K" skills/kimi-session-orchestrator/guide-orchestration.md
```
预期：每行命中一次。

---

### 任务 5：`guide-planning.md` — 第 103 行收束

**描述：** 将"同一模块连续工作"的松散建议收束为引用 SKILL.md 铁律。

**文件：**
- 修改：`skills/kimi-session-orchestrator/guide-planning.md:103`

**步骤：**

- [ ] **步骤 1：替换第 103 行**

将：
```
- 同一模块的连续工作适合同一 session 完成（上下文复用，节省 token）
```
替换为：
```
- 同模块连续工作同 session 完成（⛔ 铁律见 SKILL.md §关键约束 第7条）
```

- [ ] **步骤 2：验证**

```bash
grep "铁律见 SKILL.md" skills/kimi-session-orchestrator/guide-planning.md
```
预期：命中一次。

---

### 任务 6：`guide-loop-injection.md` — §3指标更新 + §4铁律收束

**描述：** §3 触发条件表新增 `context_tokens > 36K` 为首选行、proxy 指标标为降级方案；§4 铁律表移除与 SKILL.md 重复的 3 行，仅保留注入场景特有规则。

**文件：**
- 修改：`skills/loop-orchestrator/guide-loop-injection.md:30-44`

**步骤：**

- [ ] **步骤 1：§3 触发条件表（第 30-34 行）插入新行 + 修改**

将：
```
| 触发条件 | 操作 |
|----------|------|
| 累计注入 > 5 条独立指令 | `memory_set` 记录进度 → `memory_archive` 归档 → `create_session(from_session=旧sid)` 接班 |
| 上下文腐化信号 | `list_io_records` → `totalTurns ≥ 80` 或 `read_session_log` → `totalLines ≥ 1500` → retire |
| 产出质量下降（偏离规范/遗漏要点/幻觉） | 立即 retire |
| 跨模块切换 | 必须新 session |
```

替换为：
```
| 触发条件 | 操作 |
|----------|------|
| context_tokens > 36K（bash 通知 [CTX_HIGH]） | 同下，首选指标（v2.14） |
| 累计注入 > 5 条独立指令 | `memory_set` 记录进度 → `memory_archive` 归档 → `create_session(from_session=旧sid)` 接班 |
| totalTurns ≥ 80 或 totalLines ≥ 1500（代理指标，降级方案） | 同上 |
| 产出质量下降（偏离规范/遗漏要点/幻觉） | 立即 retire |
| 跨模块切换 | 必须新 session |
```

- [ ] **步骤 2：§4 铁律表（第 37-44 行）收缩**

将：
```
## §4 铁律

| 规则 | 原因 |
|------|------|
| 一个 execute_prompt 一个目标 | 多目标合一 → 注意力稀释 |
| 验收标准一次给完，修复一条一条来 | 验收需全局视角，修复需聚焦 |
| 跨模块必须分 session | 不同模块上下文互不相关 |
| session 复用优先 | grade_step / 修复指令同 session 继续 |
```

替换为：
```
## §4 铁律

> 通用铁律（逐条注入、session 复用优先、context_tokens 监控）见 SKILL.md §核心铁律。

| 规则 | 原因 |
|------|------|
| 验收标准一次给完，修复一条一条来 | 验收需全局视角，修复需聚焦 |
```

- [ ] **步骤 3：验证**

```bash
grep "context_tokens > 36K" skills/loop-orchestrator/guide-loop-injection.md
grep "见 SKILL.md" skills/loop-orchestrator/guide-loop-injection.md
# 验证不再包含已移除的规则：
! grep "跨模块必须分 session" skills/loop-orchestrator/guide-loop-injection.md && echo "PASS: removed"
```
预期：PASS。

---

### 任务 7：`guide-loop-core.md` — 退役指标 + 健康判定更新

**描述：** 上下文腐化监控以 `context_tokens` 为首选指标；阻塞干预中的健康判定追加 `context_tokens` 条件。

**文件：**
- 修改：`skills/loop-orchestrator/guide-loop-core.md:103-106, 130`

**步骤：**

- [ ] **步骤 1：上下文腐化监控（第 103-106 行）更新**

将：
```
- `list_io_records` → `totalTurns ≥ 80` → retire
- `read_session_log` → `totalLines ≥ 1500` → retire
- 产出质量下降（偏离规范/遗漏要点/幻觉）→ 立即 retire
```

替换为：
```
- `context_tokens > 36K`（bash 通知 [CTX_HIGH]）→ retire（v2.14 首选）
- `totalTurns ≥ 80` 或 `totalLines ≥ 1500` → retire（代理指标，降级方案）
- 产出质量下降（偏离规范/遗漏要点/幻觉）→ 立即 retire
```

- [ ] **步骤 2：阻塞干预健康判定（第 130 行）更新**

将：
```
  上下文健康（turns < 80 且 lines < 1500）?
```
替换为：
```
  上下文健康（context_tokens ≤ 36K 且 turns < 80 且 lines < 1500）?
```

- [ ] **步骤 3：验证**

```bash
grep "context_tokens > 36K" skills/loop-orchestrator/guide-loop-core.md
grep "context_tokens ≤ 36K" skills/loop-orchestrator/guide-loop-core.md
```
预期：每行命中一次。

---

### 阶段 4：构建、验证、部署

### 任务 8：构建 + bash 脚本验证

**描述：** 编译 TypeScript，运行单元级验证确认生成的 bash 脚本行为正确。

**步骤：**

- [ ] **步骤 1：构建**

```bash
cd D:/code/kimi-session-orchestrator && npm run build
```
预期：编译成功。

- [ ] **步骤 2：验证 poll_command 结构完整性**

```bash
node -e "
const { generatePollCommand } = require('./dist/poll-command.js');
const cmd = generatePollCommand({ sessionId: 'test', token: 'TEST_TOKEN' });

// 必须包含的函数和逻辑
const checks = [
  ['parse_context()', cmd.includes('parse_context()')],
  ['[CTX_HIGH]', cmd.includes('[CTX_HIGH]')],
  ['36000 threshold', cmd.includes('36000')],
  ['parse_status()', cmd.includes('parse_status()')],
  ['fetch_result()', cmd.includes('fetch_result()')],
  ['2>/dev/null guard', cmd.includes('2>/dev/null')],
  ['CTX_MAX fallback', cmd.includes('CTX_MAX:-?')],
];

let pass = true;
for (const [name, result] of checks) {
  console.log(result ? 'PASS' : 'FAIL', '-', name);
  if (!result) pass = false;
}
process.exit(pass ? 0 : 1);
"
```
预期：全部 PASS，exit 0。

- [ ] **步骤 3：验证 stdout 格式（模拟场景）**

用 bash 直接执行生成脚本的关键分支逻辑（手动注入 STATUS）：

```bash
# 模拟 context_tokens > 36K 场景
bash -c '
CTX_TOKENS=40000
CTX_MAX=131072
if [ -n "$CTX_TOKENS" ] && [ "$CTX_TOKENS" -gt 36000 ] 2>/dev/null; then
  echo "[CTX_HIGH] $CTX_TOKENS / ${CTX_MAX:-?} tokens — 建议 PM 评估退役"
fi
echo "---RESULT---"
echo "simulated result"
'
```
预期：输出包含 `[CTX_HIGH] 40000 / 131072`。

```bash
# 模拟 context_tokens ≤ 36K 场景
bash -c '
CTX_TOKENS=20000
CTX_MAX=131072
if [ -n "$CTX_TOKENS" ] && [ "$CTX_TOKENS" -gt 36000 ] 2>/dev/null; then
  echo "[CTX_HIGH] $CTX_TOKENS / ${CTX_MAX:-?} tokens — 建议 PM 评估退役"
fi
echo "---RESULT---"
echo "simulated result"
'
```
预期：输出不包含 `[CTX_HIGH]`。

---

### 任务 9：部署 skills

**描述：** 将修改后的 skill/guide 文件部署到 `~/.agents/skills/` 和 `~/.kimi-code/skills/`。

**步骤：**

- [ ] **步骤 1：部署 Agent 级 skills**

```bash
cd D:/code/kimi-session-orchestrator
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator
```

- [ ] **步骤 2：部署 PM 级 skills**

```bash
rm -rf ~/.kimi-code/skills/loop-orchestrator
cp -r skills/loop-orchestrator ~/.kimi-code/skills/loop-orchestrator
```

- [ ] **步骤 3：验证部署完整性**

```bash
grep "逐条注入" ~/.agents/skills/kimi-session-orchestrator/SKILL.md
grep "context_tokens > 36K" ~/.kimi-code/skills/loop-orchestrator/SKILL.md
grep "铁律见 SKILL.md" ~/.agents/skills/kimi-session-orchestrator/guide-orchestration.md
grep "见 SKILL.md" ~/.kimi-code/skills/loop-orchestrator/guide-loop-injection.md
```
预期：全部命中。

---

## 检查点

### 检查点：任务 1 之后
- [ ] `npm run build` 通过
- [ ] 生成的 bash 脚本含 `parse_context()` 和 `[CTX_HIGH]` 检查

### 检查点：任务 2-7 之后
- [ ] 所有 grep 验证通过
- [ ] 无 sub-guide 包含与 SKILL.md 重复的规则声明
- [ ] `context_tokens > 36K` 出现在所有退役指标列表中

### 检查点：任务 8-9 之后（最终）
- [ ] 所有验收标准满足（见规格 §验收标准 9 条）
- [ ] skills 已部署到正确位置

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `parse_context` 的 Python 一行命令语法错误 | 低 | 与 `parse_status` 使用完全相同的 Python 导入模式，已生产验证 |
| `awk` 在 Windows Git Bash 下的行为差异 | 低 | `awk '{print $1}'` 是 POSIX 标准用法，Git Bash 完整支持 |
| Sub-guide 改动遗漏引用链 | 低 | 每文件改后立即 grep 验证 |

---

## 待定问题

无。
