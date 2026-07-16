# 上下文长度 Bash 监控 + Session 规范统一

> 日期: 2026-07-16 | 版本: v2.14 | 状态: 设计已确认

## 背景

当前 bash 后台轮询脚本（`poll-command.ts`）仅在监控的 session 变为 `idle`/`aborted` 后拉取回复，不具备上下文长度感知能力。PM 无法在轮询回调中获知 session 是否接近上下文窗口上限，导致退役决策依赖 proxy 指标（wire.jsonl 行数、turn 数）而非真实 token 计数。

同时，session 创建的两条核心规范——"逐条注入"和"session 复用优先"——分散在多个 sub-guide 文件中，缺乏统一的权威入口声明。

## 目标

1. **Bash 上下文监控**：在 session 完成时自动检查 `context_tokens`，超过 36K 时在 PM 回调中附加 `[CTX_HIGH]` 提醒
2. **规范统一**：将"逐条注入"、"session 复用优先"、"context_tokens > 36K 退役"三条铁律收敛到两个 SKILL.md 入口文件

## 第一部分：Bash 上下文监控

### 数据源

`GET /api/v1/sessions/{id}/status` 响应 `data` 对象已包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | idle/running/awaiting_approval/awaiting_question/aborted |
| `context_tokens` | integer | 当前上下文 token 数 |
| `max_context_tokens` | integer | 上下文窗口上限 |
| `context_usage` | number | 占用比例（推断） |

bash 脚本的 `parse_status()` 已调用此端点——只需扩展解析逻辑，零额外 HTTP 请求。

### 阈值选择

`context_tokens > 36K` 对应约 28% 窗口占用（以 128K 常见配置估算），留 72% 余量给工具调用输出和思考链。该值低于 `session-retire` 的 ~300K 线（wire.jsonl 行数估算），因为 token 计数是精确值，无需保守估算。

### 实现方案

**仅改 `src/poll-command.ts`**，不改 `wire-client.ts` 或 MCP 工具接口。

#### 新增 `parse_context()` 函数

```bash
parse_context() {
  curl -s --max-time 10 ${authHeader} "$BASE/api/v1/sessions/$SID/status" | \
    $PY -c "import sys,json; d=json.load(sys.stdin).get('data',{}); print(d.get('context_tokens',''),d.get('max_context_tokens',''))"
}
```

#### 修改 idle/aborted 分支

当前：
```bash
if [ "$STATUS" = "idle" ] || [ "$STATUS" = "aborted" ]; then
    echo "---RESULT---"
    fetch_result
    exit 0
fi
```

改为：
```bash
if [ "$STATUS" = "idle" ] || [ "$STATUS" = "aborted" ]; then
    # Context length check (v2.14)
    CTX_INFO=$(parse_context)
    CTX_TOKENS=$(echo "$CTX_INFO" | awk '{print $1}')
    CTX_MAX=$(echo "$CTX_INFO" | awk '{print $2}')
    if [ -n "$CTX_TOKENS" ] && [ "$CTX_TOKENS" -gt 36000 ] 2>/dev/null; then
        echo "[CTX_HIGH] $CTX_TOKENS / ${CTX_MAX:-?} tokens — 建议 PM 评估退役"
    fi
    echo "---RESULT---"
    fetch_result
    exit 0
fi
```

#### PM 回调体验

bash 进程退出 → runtime 注入 `<notification>`。stdout 格式：

- 不超 36K：行为完全不变
  ```
  ---RESULT---
  （assistant 回复）
  ```
- 超 36K：追加一行提醒
  ```
  [CTX_HIGH] 38421 / 131072 tokens — 建议 PM 评估退役
  ---RESULT---
  （assistant 回复）
  ```

### 边界处理

| 场景 | 行为 |
|------|------|
| `parse_context` 失败（Server 断连/JSON 异常） | `CTX_TOKENS` 为空，跳过检查，不影响主流程 |
| `context_tokens` 恰好 = 36000 | 不触发（`-gt` 而非 `-ge`） |
| `max_context_tokens` 缺失 | 显示 `?`，不影响判断 |
| `[ "$CTX_TOKENS" -gt 36000 ]` 非整数 | `2>/dev/null` 静默跳过 |

---

## 第二部分：Skill/Guide 规范统一

### 设计原则

- **SKILL.md 的铁律/约束区是权威入口**——agent 在 Q 分支加载 sub-guide 之前先看到这些规则
- **sub-guide 按需 Read 仅为补充细节**，不复制同一条规则
- **最小改动**：每个文件改 ≤5 行

### 2.1 `kimi-session-orchestrator/SKILL.md` — "关键约束"追加

当前第 77-83 行：

```markdown
## 关键约束

1. **不要在同一 turn 内多次 poll**
2. **一个后台 bash 任务只轮询一个 session**
3. **收到通知后再读 output.log**
4. **auto_mode=true 时不需要手动审批**
5. **create_session 的 permission_mode="auto" 是 session 级别**
```

追加 3 条：

```markdown
6. **⛔ 逐条注入** — 每次 execute_prompt 只含一个操作指令；等 task session 完成
   → PM 审查 → 再发下一步。严禁一条 prompt 包多个操作。
7. **⛔ Session 复用优先** — 同模块连续工作同 session 继续；新建仅限：上下文超限 /
   产出质量下降 / 模块切换。
8. **context_tokens 监控**（v2.14）— bash 轮询完成时自动检查；> 36K 输出
   `[CTX_HIGH]` 提醒退役。
```

### 2.2 `loop-orchestrator/SKILL.md` — "核心铁律"表改 2 行

当前第 84-86 行：

```
| 一个 execute_prompt 一个目标 | 多目标合一 → 注意力腐化 |
| 跨模块必须分 session | 上下文污染 |
| session 复用优先 | grade_step / 修复同 session 继续 |
```

改为：

```
| ⛔ 逐条注入（一次一个操作指令） | 多操作合一 → 注意力稀释、PM 无法定位错误 |
| 跨模块必须分 session | 上下文污染 |
| session 复用优先 | 新建仅限：context_tokens > 36K / 质量下降 / 模块切换 |
```

后台监控自检清单追加第 5 项：

```
| 5 | Bash 通知含 [CTX_HIGH]？ | 是 → 评估退役 |
```

### 2.3 Sub-guide 冗余清扫

SKILL.md 成为权威入口后，sub-guide 中与其重复的规则声明必须移除，仅保留操作示例和场景特有的补充细节。

#### `guide-orchestration.md` — §二 压缩 + §五 阈值更新

**§二（第 14-36 行）**：移除规则声明，保留操作示例。

```
- 当前：## 二、一次性一指令原则（⛔ 核心铁律）
-       **任务注入必须逐级进行，严禁一次性全注入。**
-       每个 execute_prompt 只含一个操作...
+ 改为：## 二、逐条注入操作示例
+       > ⛔ 铁律见 SKILL.md §关键约束 第6条。以下为 7 步管线中的实际操作范例。
```

正例/反例/原因（第 20-36 行）保持不变——这些是场景特有的操作指导，非规则重复。

**§五 退役速查阈值（第 226 行）**：

```
- | 上下文预估 ~300K（wire.jsonl ~80 行 / ~10-12 轮） | **主动评估退役** |
+ | context_tokens > 36K（bash 通知 [CTX_HIGH]） | **主动评估退役**（v2.14 首选指标） |
```

#### `guide-planning.md` — 第 103 行收束

```
- - 同一模块的连续工作适合同一 session 完成（上下文复用，节省 token）
+ - 同模块连续工作同 session 完成（⛔ 铁律见 SKILL.md §关键约束 第7条）
```

#### `guide-loop-injection.md` — §3 指标更新 + §4 铁律收束

**§3 "强制拆 session 触发条件"（第 30-34 行）**：

```
  | 触发条件 | 操作 |
  |----------|------|
+ | context_tokens > 36K（bash 通知 [CTX_HIGH]） | 同下，首选指标（v2.14） |
  | 累计注入 > 5 条独立指令 | memory_set → memory_archive → create_session(from_session=旧sid) 接班 |
- | 上下文腐化信号 | list_io_records → totalTurns ≥ 80 或 read_session_log → totalLines ≥ 1500 → retire |
+ | totalTurns ≥ 80 或 totalLines ≥ 1500（代理指标，降级方案） | 同上 |
  | 产出质量下降（偏离规范/遗漏要点/幻觉） | 立即 retire |
  | 跨模块切换 | 必须新 session |
```

**§4 "铁律"（第 37-44 行）**：仅保留注入场景特有的规则。

```
- ## §4 铁律
- | 规则 | 原因 |
- |------|------|
- | 一个 execute_prompt 一个目标 | 多目标合一 → 注意力稀释 |
- | 验收标准一次给完，修复一条一条来 | 验收需全局视角，修复需聚焦 |
- | 跨模块必须分 session | 不同模块上下文互不相关 |
- | session 复用优先 | grade_step / 修复指令同 session 继续 |

+ ## §4 铁律
+ > 通用铁律（逐条注入、session 复用优先、context_tokens 监控）见 SKILL.md §核心铁律。
+
+ | 规则 | 原因 |
+ |------|------|
+ | 验收标准一次给完，修复一条一条来 | 验收需全局视角，修复需聚焦 |
```

#### `guide-loop-core.md` — 退役指标更新 + 健康判定更新

**上下文腐化监控（第 103-106 行）**：

```
- - `list_io_records` → `totalTurns ≥ 80` → retire
- - `read_session_log` → `totalLines ≥ 1500` → retire
+ - `context_tokens > 36K`（bash 通知 [CTX_HIGH]）→ retire（v2.14 首选）
+ - `totalTurns ≥ 80` 或 `totalLines ≥ 1500` → retire（代理指标，降级方案）
  - 产出质量下降（偏离规范/遗漏要点/幻觉）→ 立即 retire
```

**阻塞干预中的健康判定（第 130 行）**：

```
-   上下文健康（turns < 80 且 lines < 1500）?
+   上下文健康（context_tokens ≤ 36K 且 turns < 80 且 lines < 1500）?
```

---

## 变更总览

| 文件 | 变动量 | 类型 |
|------|--------|------|
| `src/poll-command.ts` | +15 行 | 代码 |
| `skills/kimi-session-orchestrator/SKILL.md` | +3 条约束 | 规范入口 |
| `skills/loop-orchestrator/SKILL.md` | 改 2 单元格 + 1 自检项 | 规范入口 |
| `skills/kimi-session-orchestrator/guide-orchestration.md` | -3 行 + 改 1 行 | 压缩 + 阈值 |
| `skills/kimi-session-orchestrator/guide-planning.md` | 改 1 行 | 收束 |
| `skills/loop-orchestrator/guide-loop-injection.md` | -3 行 + 改 2 行 | 压缩 + 指标 |
| `skills/loop-orchestrator/guide-loop-core.md` | 改 3 行 | 指标更新 |

共 **7 文件，~20 行代码 + ~8 行净增文档**（删除冗余 ≈ 新增）。

---

## 不涉及

- 不修改 `wire-client.ts` 或 WS 事件处理
- 不新增 MCP 工具
- 不修改 `session-watcher.ts`（内部轮询走 WS 缓存，与 bash 脚本平行）
- 不新增 sub-guide 文件
- skills/ 部署到 `~/.agents/skills/` / `~/.kimi-code/skills/` 按现有 `cp` 流程

## 验收标准

1. `poll-command.ts` 生成的 bash 脚本中 `parse_context()` 函数存在且正确解析 `context_tokens`/`max_context_tokens`
2. 模拟 `context_tokens=40000` 时，stdout 包含 `[CTX_HIGH] 40000 / ...`
3. 模拟 `context_tokens=20000` 时，stdout 不含 `[CTX_HIGH]`
4. `parse_context` 失败时（空返回），不影响主流程（不输出 `[CTX_HIGH]`、正常输出 `---RESULT---`）
5. `kimi-session-orchestrator/SKILL.md` 关键约束含 6/7/8 三条
6. `loop-orchestrator/SKILL.md` 铁律表含更新后的三行 + 自检第 5 项
7. `guide-orchestration.md` §二 不再重复声明规则（仅示例 + SKILL.md 引用）
8. `guide-loop-injection.md` §4 铁律表不再包含与 SKILL.md 重复的 3 行
9. `guide-loop-core.md` 退役指标以 `context_tokens` 为首选
