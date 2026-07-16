# 跨项目记忆 — 速查指南

> 当 PM 在规划中心统筹多个独立开发项目时，task session 的 `cwd` 指向子项目，但子项目有自己的 `.kimi-tunnel/memory.db`。v2.13 起支持双层记忆注入：全局层（planning-hub）正文直写 + 本地层（子项目）索引导航表。

---

## 一、双层记忆模型

```
planning-hub/.kimi-tunnel/memory.db     ← 全局记忆（架构决策、跨项目规范、风险、learnings）
project-a/.kimi-tunnel/memory.db        ← 本地记忆（技术栈、编码规范、项目特定决策）
project-b/.kimi-tunnel/memory.db        ← 同上
```

**注入时自动融合**：`create_session(cwd="D:/code/project-a")` 后，task session 首 turn 收到的注入文本包含两部分：

```
[系统注入] 你是 task session。
⛔ 调用 memory_get / memory_set 请使用 kimi-session-orchestrator MCP。

## 全局上下文

- **decisions**: 架构必须使用 DI 模式，禁止模块级 export const 单例
- **learnings**: Kimi Server ~20h OOM 已知问题

---

以下记忆来自 D:/code/project-a，用 memory_get 按需读取：

| 命名空间 | 条目 | 建议 |
|---------|------|------|
| project/meta | tech_stack, conventions | 必读 |
| project/decisions | coding_style | 必读 |

调用格式: memory_get(namespace="project/meta", project="D:/code/project-a")
```

---

## 二、PM 操作 — 写入子项目记忆

给子项目写入独立记忆时，使用 `project` 参数路由到子项目 DB：

```
memory_set(namespace="project/meta", key="tech_stack", value="React 18 + Vite 5", project="D:/code/project-a")
memory_set(namespace="project/meta", key="conventions", value="Tailwind CSS", project="D:/code/project-a")
```

不加 `project` 时写入 planning-hub 的记忆（全局层）：

```
memory_set(namespace="project/decisions", key="di_pattern", value="所有模块使用 DI 模式")
```

---

## 三、task session 操作 — 按需读取

task session 收到的注入文本会明确告诉它调用格式。它只需要**原样执行**：

```
memory_get(namespace="project/meta", project="D:/code/project-a")    ← 读子项目记忆
memory_get(namespace="project/meta")                                   ← 读全局记忆
memory_get(namespace="project/decisions")                              ← 读全局决策
```

| 操作 | 加 project | 不加 project |
|------|-----------|-------------|
| 读子项目技术栈/规范 | ✅ `project="D:/code/project-a"` | ❌ 读到 planning-hub 的记忆 |
| 读全局架构决策 | ❌ | ✅ 默认 tunnel DB |
| 写子项目 session findings | ✅ | ❌ 写入 planning-hub DB（通常不是意图） |

---

## 四、关键约束

| 规则 | 说明 |
|------|------|
| **全局层记忆不要重复存到子项目** | 架构决策、跨项目规范只存 planning-hub，注入时自动传播 |
| **子项目只存项目特定内容** | 技术栈、编码风格、项目特定决策 |
| **`memory_archive` 加 project** | 归档 session findings 到子项目 learnings 而非 planning-hub |
| **不加 project = 默认 tunnel DB** | 向后兼容，不加时行为及数据库不变 |
| **子项目无 `.kimi-tunnel/` 不报错** | 静默跳过，仅注入全局层 |

## 五、标准工作流

```
① PM 写入全局记忆（planning-hub DB）
   memory_set("project/decisions", "di_pattern", "DI 模式")
   memory_set("project/learnings", "server_oom", "Kimi Server ~20h OOM")

② PM 写入子项目记忆（project-a DB）
   memory_set("project/meta", "tech_stack", "React 18", project="D:/code/project-a")
   memory_set("project/meta", "conventions", "Tailwind", project="D:/code/project-a")

③ 创建子 session（cwd 指向子项目）
   create_session(cwd="D:/code/project-a", memory_level="standard")
   → 自动注入双层记忆

④ task session 按注入文本指引读取
   全局 decision 已写入正文（无需 memory_get）
   本地 meta → memory_get(namespace="project/meta", project="D:/code/project-a")

⑤ task session 完成后归档（写入子项目 DB）
   memory_archive(session_id, project="D:/code/project-a")
```

## 六、红线

| 违规 | 为什么致命 |
|------|-----------|
| **全局约束重复写到每个子项目** | 维护噩梦——一个决策改 N 处，必有不一致 |
| **写入子项目记忆不加 project** | 写到 planning-hub DB，污染全局空间，子 session 读不到 |
| **archive 不加 project** | findings 归档到 planning-hub 而非子项目，破坏了项目隔离 |
| **检查 `memory_status` 不加 project 就以为全貌** | 只看到 planning-hub 的条目数，遗漏子项目的数据 |
