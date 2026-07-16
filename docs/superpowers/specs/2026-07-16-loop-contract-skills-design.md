# Loop Contract Skills — 严格循环编排文档生成

> 头脑风暴结论 · 2026-07-16
> 配套 SPEC：006-cross-model-grader / 007-cron-scheduler-skill

---

## 一、问题

当前 `loop-orchestrator` 的启动依赖 PM 手动编写 Loop 规范。两种典型场景：

1. **文档齐全**（SPEC/PLAN/PRD/TASK）→ PM 仍需要人工提取 AC、评估复杂度、设定循环参数
2. **一句话需求** → PM 需要自行追问澄清、推断 AC、锁定方向基线

两个场景都缺乏**结构化的从需求到 Loop Contract 的转换流程**——结果就是 PM 容易跳过关键配置，导致循环变成 1-2 轮就结束的浅层执行，而非严格符合 Loop Engineering 的自主收敛系统。

---

## 二、方案：双 Skill + 共享模板

### 架构

```
用户输入
  ├─ 多份文档 → loop-contract-from-docs
  │               ├─ guide-doc-analysis（交叉对照）
  │               ├─ guide-complexity（复杂度量化）
  │               └─ guide-contract-qa（生成后审计）
  │
  └─ 一句话   → loop-contract-from-idea
                  ├─ guide-clarify-chain（5 轮追问）
                  ├─ guide-baseline-lock（基线锁定）
                  └─ guide-contract-qa（生成后审计）

              │
              ▼
         Loop Contract (.kimi-tunnel/loop-contract.yaml)
              │
              ▼
         PM 加载 → loop-orchestrator 严格按 Contract 执行
```

两个 Skill 输出**同一格式的 Loop Contract**，保证下游执行器零歧义。

### 循环保障机制（Contract 内建）

| 机制 | 防什么 |
|------|--------|
| `min_cycles ≥ 2` | 一轮就结束的浅层执行 |
| `consecutive_pass_required ≥ 2` | 修完就交付不重检 |
| `degradation_detection: true` | PM/agent 暗中缩减范围跳过验证 |
| `direction_baseline` 每轮对照 | 方向漂移 |
| `cross_model` 验证 | 同模型自我欺骗 (Yes-Spiral) |
| `blockage_recovery.max_retries + strategies` | 卡住等死 |
| `delivery_gate` 四条件同时满足 | 偷工减料交付 |

---

## 三、Loop Contract 输出格式

两个 Skill 输出同一份结构化 YAML，落到 `.kimi-tunnel/loop-contract.yaml`。

```yaml
meta:
  generated_by: loop-contract-from-docs | loop-contract-from-idea
  generated_at: <ISO timestamp>
  source_docs:                    # from-docs 列出文件；from-idea 写 "user-input"
    - specs/003/spec.md

goal:
  statement: "<一句话目标>"
  acceptance_criteria:            # 每条以可验证动词开头
    - "<返回/通过/包含/不抛出> <条件>"
  direction_baseline:             # PM 每轮循环后逐条核查
    - "<范围边界>"
    - "<不做什么>"

complexity:
  level: low | medium | high
  factors:
    - "<因素1>"

loop_config:
  min_cycles: 2                   # ≥2，不可降
  max_cycles: 5                   # 硬上限
  degradation_detection: true
  consecutive_pass_required: 2    # 连续 N 次自检无问题
  verify:
    primary: grade_step
    cross_model: gpt-5.5          # 必须 ≠ maker session 模型
    self_audit_rounds: 1          # task session 自检轮次

blockage_recovery:
  max_retries: 3
  strategies:
    - "xmind-orchestrator → 多视角分析"
    - "create_session(research) → 网络搜索"
    - "PM 缩小范围后重试"
  escalation: "3 次仍阻塞 → 暂停并报告"

pm_duties:
  per_cycle:
    - "对照 direction_baseline 核查方向一致性"
    - "检测降级倾向：缩减范围/跳过验证/省略检查"
  on_blockage:
    - "先诊断后决策"

delivery_gate:
  - min_cycles 满足
  - consecutive_pass_required 满足
  - direction_baseline 全部通过
  - PM 确认：方向一致且未发现降级
```

### 模板校验规则（guide-contract-qa）

```
□ meta 全部字段非空
□ goal.statement ≤ 3 句话
□ goal.acceptance_criteria 每条以可验证动词开头
□ complexity.factors ≥ 2 条
□ loop_config.min_cycles ≥ 2
□ loop_config.max_cycles > min_cycles
□ verify.cross_model ≠ PM session 当前模型
□ blockage_recovery.strategies ≥ 2 条
□ pm_duties.per_cycle ≥ 2 条
□ delivery_gate 全部条件互不重叠且独立可验
```

---

## 四、Skill A：loop-contract-from-docs

触发：`/loop-contract` 或 PM 指定项目路径 + 文档集。

### 管线

```
Phase 1: 文档侦察（guide-doc-analysis）
  ① 读取全部指定文档
  ② 交叉对照：SPEC 接口定义 ↔ PLAN 实现步骤 ↔ TASK 粒度
  ③ 输出一致性报告 + 已覆盖/遗漏/矛盾点

Phase 2: 基准提取
  ④ 提取 AC（优先 SPEC 的 AC 章节）
  ⑤ 提取方向约束：范围边界、不定制项、接口契约
  ⑥ 计算复杂度（guide-complexity）

Phase 3: 循环深度判定
  ⑦ 输入：complexity level + 文档质量
  ⑧ 输出循环参数：
     low  → min=2, consec=2, max=4
     med  → min=3, consec=2, max=5
     high → min=4, consec=3, max=6

Phase 4: 生成
  ⑨ 模板填充 → loop-contract.yaml
  ⑩ 自检（guide-contract-qa）→ 不通过则修正

Phase 5: 交接
  ⑪ 摘要卡片 → PM 确认 → 进入 loop-orchestrator
```

### Guide 清单

| Guide | 职责 |
|-------|------|
| `guide-doc-analysis` | 多文档交叉对照方法论：AC 提取优先级、矛盾检测、遗漏标记 |
| `guide-complexity` | 复杂度量化：文件数 × 跨模块依赖 × 协议层/DB schema 权重 |
| `guide-contract-qa` | 生成后逐字段审计 + 降级探测 |

---

## 五、Skill B：loop-contract-from-idea

触发：`/loop-contract-new` 或 PM 输入一句话需求。

### 管线

```
Phase 1: 5 轮追问（guide-clarify-chain）
  Q1: 最终目标？（含：谁用、做什么、为什么重要）
  Q2: 平台/环境约束？
  Q3: 技术栈？
  Q4: 方向约束？（明确不做什么）
  Q5: 已有文档？→ 有则升级为 from-docs 路径

Phase 2: 基线锁定（guide-baseline-lock）
  ② 从 Q1-Q4 推断 AC 草案
  ③ 推断方向基线
  ④ 展示 → 用户确认 → 锁定（此后不可自行修改）

Phase 3: 复杂度评估
  ⑤ 基于 Q2-Q4 推断 → complexity level

Phase 4-5: 同 from-docs 的 Phase 3-5
```

### 与 from-docs 的核心差异

| 维度 | from-docs | from-idea |
|------|-----------|-----------|
| 输入质量 | 已有 SPEC/PLAN，AC 精确提取 | 一句话，AC 需 PM 推断 + 用户确认 |
| 方向基线来源 | 文档自动提取 | Q1-Q4 追问锁定 |
| 追问量 | 0 | 5 轮 |
| 基线修改权 | 不可改（文档 = 事实） | PM 推断 → 用户确认后可改 |
| AC 精度 | 逐条可验证 | PM 推断草案 → 用户确认 |

### Guide 清单

| Guide | 职责 |
|-------|------|
| `guide-clarify-chain` | 5 轮追问：每轮退出标准 + 回答不充分时的追问策略 |
| `guide-baseline-lock` | AC 推断→展示→确认→锁定四步协议 |
| `guide-contract-qa` | 同 from-docs：逐字段审计 + 降级探测 |

---

## 六、文件结构

```
skills/
├── loop-contract-from-docs/
│   ├── SKILL.md                      # 入口 + Phase 1-5 流程
│   ├── guide-doc-analysis.md         # 文档侦察 + 交叉对照
│   ├── guide-complexity.md           # 复杂度量化矩阵
│   ├── guide-contract-qa.md          # 生成后审计
│   └── templates/
│       └── loop-contract.yaml        # 共享模板
│
└── loop-contract-from-idea/
    ├── SKILL.md                      # 入口 + Phase 1-5 流程
    ├── guide-clarify-chain.md        # 5 轮追问链
    ├── guide-baseline-lock.md        # 方向基线锁定协议
    ├── guide-contract-qa.md          # 生成后审计
    └── templates/                    # 空（引用 from-docs 模板）
```

---

## 七、与现有体系的关系

```
cron-scheduler (007) ──触发──→ loop-contract-from-docs/from-idea (本 spec)
                                    │
                                    ▼
                              Loop Contract (.yaml)
                                    │
                                    ▼
                              loop-orchestrator (已有)
                              ├─ grade_step (006 cross-model)
                              ├─ xmind-orchestrated (阻塞恢复)
                              ├─ session-retire (退役接班)
                              └─ memory_set/get (状态持久化)
```

---

## 八、验收标准

1. `loop-contract-from-docs` 输入 SPEC+PLAN → 输出 Contract，`min_cycles ≥ 2`
2. `loop-contract-from-idea` 输入一句话 → 5 轮追问 → 基线锁定 → 输出 Contract
3. `guide-contract-qa` 对输出进行 10 项模板校验，不通过则拒绝输出
4. Contract 中 `verify.cross_model` 自动选定与 PM session 不同的模型
5. `degradation_detection` 设为 true 后，PM 每轮自动检测降级倾向
6. 两种路径输出的 Contract 格式严格一致（下游 loop-orchestrator 零歧义）
