---
name: xmind
description: 思维导图——当陷入复杂问题、遇到架构死胡同、在同一 bug 上无进展、或需要宏观视角时使用，用户说"思维导图"/"mind map"分析问题时触发
---

# XMIND — 困境梳理 + 新视角方案生成

## 概述

遇到困境时自动收集当前问题点与项目必读文档，打包交给独立子 Agent，该 Agent 从头理解项目全局后使用 zoom-out 退后一步，以宏观视角给出全新方案。**方案被拒绝时，将拒绝原因注入交接包进入下一轮迭代，最多 3 轮。**

**核心原则：** 困境中的 Agent 有思维惯性——它熟悉自己的解决方案，难以自我推翻。独立的新 Agent 不受此惯性约束。

## 何时使用

| 症状 | 示例 |
|------|------|
| 同一 bug 修了 2 次仍未解决 | "又错了，再查一次……" |
| 发现架构级矛盾但不知如何取舍 | "这样改会破坏A，那样改会破坏B" |
| 陷入细节无法判断优先级 | "现在该先做哪个？" |
| 需要全新视角审视方案 | "有没有完全不同的思路？" |

**不适用：** 单步操作（改一行配置）、已明确方案只需执行。

## 交接包 Schema（CRITICAL —— 单一事实来源）

子 Agent 工作流和交接包格式均以此 Schema 为准。必填字段缺失时拒绝传递，提示补全。

```
HandoffPackage {
  // 必填段
  project: {
    name: string            // required
    stack: string           // required, 语言/框架/工具链
    cwd: string             // required, 工作目录
  }
  docs: [{
    path: string            // required
    summary: string         // required, 一句话摘要
  }]                        // required, min 1

  problems: [{
    title: string           // required
    symptom: string         // required, 可观测现象
    attempts: [{
      solution: string      // required, 已尝试的方案
      why_failed: string    // required, 失败原因
    }]
    files: string[]         // 涉及的文件/模块列表
  }]                        // required, min 1

  constraints: {
    no_modify: string[]     // 不能修改的模块
    perf_floor: string      // 性能底线阈值
    compat: string          // 兼容性要求
  }                         // required

  // 迭代段（由反馈闭环自动填充）
  iteration: number          // 当前迭代轮次, 0=首次
  rejections: [{
    round: number
    proposal_title: string
    reason: string           // 用户拒绝原因
  }]

  // 子Agent工作流指令（从 SUBAGENT-WORKFLOW 注入）
  subagent_workflow: string  // required
}

// 验证规则
必填字段缺失 → 拒绝传递 → 提示 "HandoffPackage 验证失败: 缺少 [字段名]"
docs 长度 < 1  → 拒绝传递 → 提示 "至少提供 1 个必读文档"
problems 长度 < 1 → 拒绝传递 → 提示 "至少描述 1 个问题"
```

子 Agent 工作流指令（`subagent_workflow` 字段内容，从 SUBAGENT-WORKFLOW.md 注入）：

```
请按以下步骤工作：
1. 通读 docs 中列出的所有必读文档，理解项目架构、约束和规范
2. 逐个分析 problems，理解为何已尝试的方案失败
3. 调用 zoom-out：绘制模块关系图，用项目术语描述全局架构
   - 若 zoom-out skill 不可用：手动绘制模块依赖图 + 用 constraints 中的术语描述全局
4. 基于宏观理解，提出 1-3 个新方案
5. 每个方案标注：
   - 可行性（高/中/低） + 理由
   - 风险
   - 与已尝试方案的本质区别（不能只是旧方案的微小变体）
6. 考虑 rejections 中的拒绝原因（如有），避免重复被拒绝的路径
```

## 执行流程

```
当前 session 遇到困境
        ↓
  Step 1: 梳理问题清单（可执行）
  ├─ grep 对话历史: 搜索 "❌""失败""不行""bug""卡" 等困境关键词
  ├─ 检查 CLAUDE.md/AGENTS.md 中的 TODO/task 列表
  └─ git diff --stat 查看最近修改文件，标注涉及模块
        ↓
  Step 2: 收集必读文档（可执行）
  ├─ glob **/CLAUDE.md + **/AGENTS.md + **/README.md
  ├─ glob **/specs/**/spec.md + **/specs/**/plan.md
  ├─ 按 mtime 排序，取前 3 个最相关
  └─ 每篇文档读前 50 行提取摘要
        ↓
  Step 3: 按 Schema 编制交接包
  ├─ 填充 project / docs / problems / constraints
  ├─ 验证必填字段完整性
  ├─ 检查 zoom-out 依赖: 可用? → 注入标准 workflow
  │                    不可用? → 注入 fallback workflow
  ├─ 计算上下文预算: budget = model_context_window × 0.05
  │   deepseek-v4-pro: 262K → 13K tokens
  │   deepseek-v4-pro[1m]: 1M → 50K tokens
  └─ 交接包超过预算 → 压缩 docs 摘要 + 精简 problems 描述
        ↓
  Step 4: 按问题独立性分派子 Agent
  ├─ 问题清单含 ≥2 个独立问题 → 并行启动 N 个子 Agent
  │   （独立 = 不共享文件/不互为依赖）
  ├─ 否则 → 单子 Agent 处理全部问题
  └─ 每个子 Agent 交接包含完整的 subagent_workflow
        ↓
  Step 5: 接收方案，呈现给用户
  └─ 合并并行子Agent结果（如有）
        ↓
    ⛔ 等待用户决策
        ↓
  ┌─ 用户接受方案? → 结束（进入 selftest → 实施）
  └─ 用户拒绝? → iteration < 3?
                  ├─ Yes → 注入 rejections + iteration++
                  │        → 回到 Step 4（重新启动子Agent）
                  └─ No  → 标记"需人工决策"
                           输出完整的 3 轮拒绝记录
```

## 快速参考

```
/xmind                      → 对当前困境执行完整流程
/xmind --quick              → 快速版（仅列问题，跳过文档收集，单轮迭代）
/xmind --problem "<描述>"   → 针对特定问题启动
/xmind --parallel           → 强制并行处理（即使问题可能相关）
```

## 常见错误

| 错误 | 纠正 |
|------|------|
| 在交接包中写"按之前的方案继续" | 新 Agent 不知道"之前"是什么，必须完整描述 |
| 不提供必读文档列表 | Schema 强制 min 1 docs，违反则拒绝传递 |
| 子 Agent 忘记调用 zoom-out | subagent_workflow 第一条就是调用 zoom-out，含 fallback |
| 交接包超过模型预算 | 动态公式 budget = context_window × 0.05，超过则压缩 |
| 把相关的问题强行并行 | 先判断独立性：不共享文件 + 不互为依赖 → 才并行 |
| 用户拒绝后不再尝试 | 最多 3 轮迭代，拒绝原因驱动下一轮交接包改进 |

## 与已有 skill 的协作

- **selftest** — Xmind 生成的新方案执行前，需经过 selftest 四维审查
- **zoom-out** — Xmind 子 Agent 的核心工具，用于获得宏观视角。不可用时自动 fallback
- **handoff** — Xmind 借用 handoff 的交接文档思路，但专注于问题求解而非进度接手
- **systematic-debugging** — Xmind 是其 Step 3（系统性排查）的升级版：引入独立 Agent 打破思维惯性
