# Loop 核心执行循环

> 加载条件：Q3 选择后 Read。定义 PM 进入自主编排后的完整 6 阶段循环。

---

## §1 阶段 0 — 记忆加载

```
memory_get(namespace="project/meta")     → 技术栈/规范/约定
memory_get(namespace="project/learnings") → 过往 session 沉淀经验
```

若 project/ 命名空间为空 → 跳过，不阻塞。

> 完整 memory 操作映射见 → Read `~/.kimi-code/skills/loop-orchestrator/guide-loop-memory.md`

---

## §2 阶段 1 — 拆解

按验收标准维度拆分工作包。判定注入粒度：

单次注入条件（全部满足）：
  ① 工作包 ≤ 3 条独立验收项
  ② 项间无先后依赖
  ③ 总指令 ≤ 500 字
  ④ 无需运行测试/构建等耗时验证

任一条不满足 → 分次注入。

拆解完成后：
```
memory_set(namespace="session/loop-<loop-id>", key="plan", value="<plan JSON>") ← 持久化
```
`loop-id = loop-<ISO timestamp>`。

> 详细注入判定规则见 → Read `~/.kimi-code/skills/loop-orchestrator/guide-loop-injection.md`

---

## §3 阶段 2 — 执行循环协议

每个工作包按编号步骤执行。**一步未满足门控，禁止进入下一步。**

### 工作包循环

```
STEP 1 — 创建 session
  操作: create_session(cwd, permission_mode="auto")
  产出: session_id
  ✓ 门控: session_id 非空

STEP 2 — 下发任务
  操作: execute_prompt(sid, task, auto_mode=true)
  产出: { submitted: true, poll_command: "<python3 ...>" }
  ✓ 门控: submitted=true 且 poll_command 非空
  ⛔ 完成此步后禁止做任何其他工具调用，立即进入 STEP 3

STEP 3 — 启动监控 ⛔ 不可跳过
  操作: Bash(run_in_background=true, description="轮询 <sid>")
        命令 = poll_command 原文（一字不改）
  产出: task_id
  ✓ 门控: task_id 非空
  ⛔ 未拿到 task_id 不得离开此步。没有 task_id = 监控未启动 = 循环断裂。

STEP 4 — 记录追踪
  操作: PM 内部记录当前活跃映射 { session_id → task_id }
  ✓ 门控: 所有已提交 prompt 的 session 均有对应 task_id

STEP 5 — 等待结果（跨 turn）
  操作:
    - 收到 <notification> → Read output_path → 拿到回复 → 进入 STEP 6
    - 无 notification → 可处理其他工作包（从 STEP 1 另起循环），不阻塞等
  门控: 回复内容非空

STEP 6 — 验证决策
  操作: 按 §7 节奏表判定是否需要 grade_step
    yes:
      grade_step(sid, criteria)
        pass → STEP 7
        fail → execute_prompt(sid, 修复指令) → 回到 STEP 3（retry+1）
               ≤2 retry → 第3次 fail → 进入 §4 阶段3
    no:
      PM spot-check → STEP 7
  ✓ 门控: 产出已验证或已判定无需验证

STEP 7 — 完成工作包
  操作: memory_set(namespace="session/<sid>", key="findings", value="<JSON>")
        → 下一工作包 → 回到 STEP 1
  ✓ 门控: findings 已持久化
```

### ⛔ 禁止项

| 禁止行为 | 原因 |
|----------|------|
| STEP 2 后直接跳到 STEP 5/6 不做 STEP 3 | 监控未启动，永无 notification |
| 用 `poll_session` 代替 STEP 3 | 每次 poll 消耗 token，无自动通知 |
| `Bash` 命令不是 poll_command 原文 | 脚本语法差异导致静默失败 |
| 多个 session 共用同一个 Bash 后台任务 | 一个 Bash 只轮询一个 session |

**上下文腐化监控：**
- `context_tokens > 36K`（bash 通知 [CTX_HIGH]）→ retire（v2.14 首选）
- `totalTurns ≥ 80` 或 `totalLines ≥ 1500` → retire（代理指标，降级方案）
- 产出质量下降（偏离规范/遗漏要点/幻觉）→ 立即 retire

**强制拆 session 操作序列：**
```
memory_set(namespace="session/loop-<id>", key="progress", value="<progress JSON>")
memory_archive(旧sid)
create_session(from_session=旧sid, cwd=..., permission_mode="auto")
```

---

## §4 阶段 3 — 阻塞干预

触发条件：session 卡死 / 3 次 retry 失败 / loop 指纹触发。

```
诊断：read_session_log + list_io_records
决策树：
  ├─ 方向问题? → 创建诊断 session 分析根因
  ├─ 知识缺口? → 创建搜索 session 补充信息
  ├─ 思维僵局? → 调用 xmind-orchestrated
  └─ 无法解决? → 暂停向用户汇报（不降级）

诊断结果拿到后：
  上下文健康（context_tokens ≤ 36K 且 turns < 80 且 lines < 1500）?
    → 注入原 session → 重试（重置 retry 计数）
  上下文腐化?
    → memory_set(namespace="session/loop-<id>", key="progress", value="<progress JSON>")
    → memory_archive 归档
    → create_session(from_session=旧sid) 接班
    → 新 session 重试

诊断后重试仍 2 次失败 → 暂停向用户汇报
  汇报含：阻塞历史 + 已尝试方案 + 疑点
  不自行降级目标
```

> 完整决策树及诊断 session 创建规范见 → Read `~/.kimi-code/skills/loop-orchestrator/guide-loop-blockage.md`

---

## §5 阶段 4 — 里程碑汇报

每完成一个模块/工作包：

```
📦 {模块} 完成: {M} PASS / {N} FAIL → 已修复
memory_set(namespace="session/loop-<id>", key="milestones", value="<milestones JSON>")
```

不等待用户确认，直接进入下一工作包。

---

## §6 阶段 5 — 交付

全部验收标准通过：

```
memory_archive(session_id) → findings → learnings
最终报告（全模块 PASS/FAIL 历史 + 修复记录）
```

> 交付归档完整流程见 → Read `~/.kimi-code/skills/loop-orchestrator/guide-loop-deliver.md`

---

## §7 grade_step 使用节奏

| 场景 | 是否 grade_step | 原因 |
|------|:--:|------|
| task session 完成首次验收输出 | ✅ yes | 关键产出 |
| 修复后重新输出 | ✅ yes | 验证修复 |
| 最终交付前 | ✅ yes | 全量终验 |
| 中间辅助步骤（如"读取 spec"） | ❌ no | PM spot-check 即可 |
| 阻塞诊断 session 的分析结果 | ❌ no | 供 PM 决策，非交付物 |
| "已确认，开始执行" 等确认回复 | ❌ no | 无实质产出 |

## §8 PM Spot-check

即使 grade_step pass (score ≥ 70)，抽查：
- 产出中引用的文件路径是否存在
- 修复是否真的改了代码（对比修复前后）
- 是否引入了新的越权操作

## §9 Kimi Server 断连恢复

Loop 执行中若 tool 调用报错或 `get_tunnel_status` 显示 `wireConnected: false`，按以下流程自主恢复。

### 检测信号

| 信号 | 确认方式 |
|------|----------|
| MCP 工具调用报错（含 "Wire client 未连接"） | 下一个 turn 立即检查 |
| `get_tunnel_status` → `wireConnected: false` | 主动检查（每 5-10 轮可顺手查一次） |
| Bash 后台任务异常退出（轮询脚本报 connection refused） | notification 到达时检查输出 |

### 恢复流程

```
STEP R1 — 确认 Kimi Server 状态
  Bash: cat ~/.kimi-code/server/lock
    lock 存在且 PID 存活 → 跳过 R2，直接 R3（等待自动重连）
    lock 不存在 → 进入 R2

STEP R2 — 启动 Kimi Server
  Bash(run_in_background=true): kimi web --no-open &
  等待 8-10s，确认 lock 文件出现且 port 字段有效

STEP R3 — 等待 Tunnel 自动重连
  Tunnel 每 10s 检测 lock 并重试连接 → 等待 30-60s
  get_tunnel_status → wireConnected: true ? → 进入 R4
  超过 120s 仍未恢复 → /reload（重启 MCP 进程强制重连）

STEP R4 — 恢复循环状态
  ✓ wireConnected=true 确认
  检查活跃 session：poll_session 逐个确认状态
  检查 Bash 后台任务：TaskList 查看是否因断连异常退出
  异常退出的 Bash → 重新启动（从 poll_command 重建）
  全部 task session 状态确认后 → 回到断连前环节继续 Loop
```

### 断连期间保障

| 项 | 说明 |
|----|------|
| 已提交的 task session | **不受影响**——prompt 在 Kimi Server 端继续执行 |
| Bash 后台轮询 | 断连期间轮询脚本报错退出，恢复后需重建 |
| PM 编排状态 | Loop 上下文（拆解方案/进度/活跃 session）保留在 PM session 中 |
| 最长可容忍中断 | ~2h——Kimi Server 侧 session 有超时但较长 |

### 恢复后必做

1. `get_tunnel_status` → 确认 `wireConnected: true`
2. `TaskList` → 检查后台 Bash 任务，重建已退出的
3. 逐个 `poll_session` 活跃 task session → 确认状态
4. 已完成的 session → 正常走 STEP 6 验证流程
5. 仍在运行的 → 确认有对应的 Bash 后台监控在运行

---

> 完整规范见 `docs/superpowers/specs/2026-07-15-loop-orchestrator-v2-design.md`
