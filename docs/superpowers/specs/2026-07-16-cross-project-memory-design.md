# 跨项目记忆注入：双层架构设计

**日期**: 2026-07-16
**状态**: Draft
**关联**: SPEC 002（Session 冷启动记忆共享）、SPEC 004（记忆注入策略升级）

## 1. 问题

### 1.1 场景

PM 在 **规划中心**（`D:/code/planning-hub`）统筹多个**独立开发项目**（`D:/code/project-a`、`D:/code/project-b`）：

```
D:/code/planning-hub/          ← PM 启动 orchestrator，有 .kimi-tunnel/memory.db
│                                （存储：架构决策、跨项目规范、风险、learnings）
│
├─ 子 session → D:/code/project-a   ← 有自己的 .kimi-tunnel/memory.db
│                                        （存储：技术栈、编码规范、项目特定决策）
│
└─ 子 session → D:/code/project-b   ← 同上
```

### 1.2 现状缺陷

`buildInjection()` 接收 `profile.cwd` 但从未消费。所有 memory 操作始终路由到 `tunnelProjectRoot`（即 planning-hub 自身的 DB），子项目的 `.kimi-tunnel/memory.db` 被完全忽略。

```typescript
// helpers.ts:38 — 写死的 tunnelProjectRoot
memoryStore.ensureDb(tunnelProjectRoot);
memoryStore.buildInjection({ cwd: profile.cwd }); // cwd 传入但 buildInjection 不读
```

### 1.3 设计目标

- task session 启动时自动注入**两层记忆**：planning-hub 全局决策 + 子项目本地规范
- PM 零手动维护，子项目记忆独立自治
- 向后兼容，不加 `project` 参数时行为不变

## 2. 方案：双层注入 + project 参数路由

### 2.1 核心思路

**不是合并两个数据库**，而是分成两层注入：

1. **全局层**（planning-hub 的记忆）：正文直接写入注入文本，task session 不需要再 `memory_get`
2. **本地层**（子项目的记忆）：注入索引，task session 用 `memory_get(namespace, project="D:/code/project-a")` 按需拉取

### 2.2 注入文本示例

task session 首 turn 收到的注入内容将变成：

```
[系统注入] 你是 task session。
⛔ 调用 memory_get / memory_set 请使用 kimi-session-orchestrator MCP。

## 全局上下文（来自 planning-hub）

- **decisions**: 架构必须使用 DI 模式，禁止模块级 export const 单例
- **learnings**: Kimi Server ~20h OOM 已知问题，依赖 §9 恢复流程

---

以下记忆来自 D:/code/project-a，用 memory_get 按需读取：

| 命名空间 | 条目 | 建议 |
|---------|------|------|
| project/meta | tech_stack, conventions | 必读 |
| project/decisions | coding_style | 必读 |

调用格式: memory_get(namespace="project/meta", project="D:/code/project-a")
```

### 2.3 project 参数路由

6 个 MCP 工具各加一个可选的 `project` 参数（string, absolute path）：

```typescript
// 工具层：有 project → 先 ensureDb(project) 切换，再执行原逻辑
if (project) {
  const resolved = memoryStore.resolveProjectRoot(project);
  if (resolved) memoryStore.ensureDb(resolved);
}
memoryStore.get(namespace, key, includeExpired);
```

- 不加 `project`：行为不变，走当前 DB（tunnel 初始化时绑定的 planning-hub）
- `project="D:/code/project-a"`：orchestrator 自动解析 `.kimi-tunnel/` 并临时切换 DB
- 解析失败：返回友好错误 `"D:/code/project-a 下未找到 .kimi-tunnel/ 目录"`

## 3. 改动清单

### 3.1 memory-store.ts

#### `buildInjection(profile)` — 消费 `profile.cwd`

在现有逻辑之前插入全局层正文收集和本地层索引生成：

```
buildInjection 流程（原）:
  ① 收集 planning-hub 的命名空间条目
  ② 收集 fromSession handoff
  ③ 按 level 生成注入文本

buildInjection 流程（新）:
  ① 收集 planning-hub 的命名空间条目 → 作为"全局上下文"正文写入
  ② 若 profile.cwd != tunnelProjectRoot，解析子项目 DB → 收集条目 → 作为索引表写入
  ③ 收集 fromSession handoff
  ④ 按 level 生成注入文本（全局正文 + 本地索引 + handoff）
```

关键约束：
- 全局层沿用现有 `level` 格式：minimal=单句指令, standard=bullet 列表, full=索引导航表（>20 条时 value 列折叠为 "(N 条)"）
- 本地层始终用索引导航表格式（`| namespace | 条目 | 建议 |`），不受全局层 level 影响
- 全局层正文 + 本地层索引总大小 ≤ `profile.maxBytes`（默认 8192），超限时优先保证全局层完整，本地层截断
- 本地层无 `.kimi-tunnel/` 时静默跳过（不阻塞 session 创建）
- `profile.cwd` 与 `tunnelProjectRoot` 指向同一目录时跳过本地层（避免重复注入）

#### MemoryStore 新增辅助方法（可选）

```typescript
/** 读取指定 projectRoot 的条目（不切换 DB 连接，新建临时连接） */
getFromProject(projectRoot: string, namespace: string, key?: string): MemoryEntry[]
```

或者当前 `ensureDb` 已支持切换，直接用现有 `get` 即可。权衡：临时切换 DB 有连接开销，但实现简单。子 session 的生命周期内通常只切换一次——注入时。task session 后续主动调用 `memory_get` 才需要反复切换。

**决策**：用 `ensureDb` 切换，不做临时连接。切换开销可接受（SQLite 轻量），且 `ensureDb` 已有同项目去重守卫。

### 3.2 6 个 MCP 工具

每个工具加 `project` 可选参数，在调用 `memoryStore.*` 之前：

```typescript
// 工具 handler 内
const { memoryStore, tunnelProjectRoot } = services;

if (project) {
  const resolved = memoryStore.resolveProjectRoot(project);
  if (!resolved) {
    return { content: [{ type: "text", text: `${project} 下未找到 .kimi-tunnel/ 目录` }], isError: true };
  }
  memoryStore.ensureDb(resolved);
} else {
  // ensureDb(tunnelProjectRoot) 已在启动时调用，无需重复
}
// ... 现有逻辑
```

| 工具 | 文件 | 改动行数（估计） |
|------|------|:--:|
| `memory_get` | `memory-get.ts` | +10 |
| `memory_set` | `memory-set.ts` | +10 |
| `memory_list` | `memory-list.ts` | +10 |
| `memory_delete` | `memory-delete.ts` | +10 |
| `memory_status` | `memory-status.ts` | +10 |
| `memory_archive` | `memory-archive.ts` | +10 |

### 3.3 helpers.ts

`injectMemoryIntoPrompt` — 无需改结构。`profile.cwd` 已经传入 `buildInjection`，只需 buildInjection 内部消费它。

### 3.4 不涉及的改动

- `create-session.ts` — cwd 已存到 profile ✓
- `execute-prompt.ts` / `chat-with-session.ts` — preparePrompt 链条完整 ✓
- `workflow-engine.ts` — driveStep 使用 injectMemoryIntoPrompt ✓
- 11 个 skill/guide 文件 — `project` 是可选的向后兼容参数 ✓

## 4. 边界与约束

### 4.1 不做什么

- **不合并数据库**。全局层和本地层在注入文本中并列，不创建跨 DB 的联合查询
- **不处理 project 参数与 tunnelProjectRoot 相同时的情况**。相等时跳过本地层，避免重复注入相同内容
- **不持久化 DB 切换**。每次 MCP 工具调用独立处理 `project` 参数，工具返回后 `projectRoot` 保持在 tunnel 原始值

### 4.2 已知限制

- `memory_status` 加 `project` 参数后只显示指定项目的状态，不显示跨项目聚合
- 子项目无 `.kimi-tunnel/` 时不报错，静默跳过——task session 只收到全局层
- 本地层条目超 `maxBytes` 限制时，全局层优先保证完整性，本地层可被截断

## 5. 测试要点

1. `create_session(cwd="D:/code/project-a", memory_level="standard")` → 注入文本包含 planning-hub 全局决策 + project-a 本地规范索引
2. `memory_get(namespace="project/meta", project="D:/code/project-a")` → 返回 project-a 的条目
3. `memory_get(namespace="project/meta")`（不加 project）→ 返回 planning-hub 的条目（行为不变）
4. `create_session(cwd="D:/code/planning-hub")`（子项目=planning-hub 自身）→ 注入文本不重复，只有单层
5. 子项目无 `.kimi-tunnel/` → 注入文本只有全局层，无报错
6. 全局记忆为空 + 子项目有记忆 → 注入文本只有本地层索引
7. 全局 + 本地总计超 8192 字节 → 全局层完整，本地层截断

## 6. 风险

| 风险 | 缓解 |
|------|------|
| `ensureDb` 频繁切换导致连接开销 | SQLite 切换是轻量的；同项目有去重守卫；典型场景下一个 task session 生命周期内本地项目不变 |
| `resolveProjectRoot` 在 Windows 路径下向上查找行为 | 已有实现且经过跨平台验证（`index.ts:30` 使用相同方法） |
| DB 切换是全局状态，并发 tool 调用可能竞态 | MCP stdio 是串行处理，不存在并发；HTTP server 的 WS 客户端调用 memory 工具时同理 |

## 7. 实现优先级

| 步骤 | 内容 | 估时 |
|:--:|------|:--:|
| 1 | `buildInjection` 消费 `profile.cwd`，生成双层注入文本 | 核心 |
| 2 | 6 个 MCP 工具加 `project` 参数 + 路由逻辑 | 核心 |
| 3 | 构建验证（`npm run build` 零错误） | 验证 |
| 4 | 本机测试：planning-hub + 子项目场景 | 验证 |
| 5 | 更新 AGENTS.md 记录决策 | 文档 |
