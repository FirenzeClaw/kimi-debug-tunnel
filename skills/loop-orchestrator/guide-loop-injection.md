# 注入防腐化规则

> 加载条件：阶段 1 拆解时 Read。避免一次注入过多指令导致 task session 注意力稀释。

---

## §1 单次注入判定

```
单次注入条件（全部满足）：
  ① 工作包 ≤ 3 条独立验收项
  ② 项间无先后依赖（可并行检查）
  ③ 总指令 ≤ 500 字
  ④ 无需运行测试/构建等耗时验证

任一条不满足 → 分次注入
```

## §2 分次注入流程

```
session 1: execute_prompt(step_1) → grade → PASS
session 1（复用）: execute_prompt(step_2) → grade → PASS
...
同一 session 串行注入，完成即进下一步
```

## §3 强制拆 session 触发条件

| 触发条件 | 操作 |
|----------|------|
| context_tokens > 36K（bash 通知 [CTX_HIGH]） | 同下，首选指标（v2.14） |
| 累计注入 > 5 条独立指令 | `memory_set` 记录进度 → `memory_archive` 归档 → `create_session(from_session=旧sid)` 接班 |
| totalTurns ≥ 80 或 totalLines ≥ 1500（代理指标，降级方案） | 同上 |
| 产出质量下降（偏离规范/遗漏要点/幻觉） | 立即 retire |
| 跨模块切换 | 必须新 session |

## §4 铁律

> 通用铁律（逐条注入、session 复用优先、context_tokens 监控）见 SKILL.md §核心铁律。

| 规则 | 原因 |
|------|------|
| 验收标准一次给完，修复一条一条来 | 验收需全局视角，修复需聚焦 |

---

> 完整规范见 spec §4
