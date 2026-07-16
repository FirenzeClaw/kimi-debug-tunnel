# 跨项目记忆注入 实现计划

> **面向 AI 代理的工作者：** 使用 subagent-driven-development 或 executing-plans 逐任务实现此计划。

**目标：** task session 的 cwd 指向独立项目时，自动注入双层记忆（planning-hub 全局决策 + 子项目本地规范）

**架构：** `buildInjection()` 消费 `profile.cwd` → 全局层正文直写 + 本地层索引导航表。6 个 `memory_*` MCP 工具各加可选 `project` 参数，按需路由 DB。向后兼容，不加参数行为不变。

**技术栈：** TypeScript 5.6, node:sqlite, MCP SDK 1.12, Zod 3

**设计文档：** `docs/superpowers/specs/2026-07-16-cross-project-memory-design.md`

---

## 架构决策

- **双层非合并**：全局层（tunnel DB）正文直写 + 本地层（子项目 DB）索引导航表，不创建跨 DB 联合查询
- **`ensureDb` 切换而非临时连接**：SQLite 切换轻量，去重守卫已有，避免双连接管理复杂度
- **DB 状态修复**：MCP 工具 `else` 分支显式 `ensureDb(tunnelProjectRoot)`；`buildInjection` 末尾切回
- **本地层沿用 `memory_level`**：minimal→仅 meta, standard→+decisions, full→全部
- **项目根解析兜底**：`resolveProjectRoot(cwd)` 处理子目录路径，无 `.kimi-tunnel/` 时静默跳过

---

## 任务列表

### 任务 1：memory-store.ts — buildInjection 双层注入

**文件：**
- 修改：`src/memory-store.ts:315-432`

**描述：** 在 `buildInjection` 中收集全局层条目（现有逻辑），然后检测 `profile.cwd` 是否需要子项目本地层。若是，临时切换 DB 收集本地条目，生成双层注入文本，最后切回 tunnel DB。

**涉及改动：**

- [ ] **步骤 1：提取全局层收集 + handoff 为独立变量，新增本地层逻辑**

在当前 `buildInjection` 中，全局层 collect（行 338-350）和 handoff（行 357-364）保持不变，之后新增：

```typescript
// --- Local layer: child project memory (NEW) ---
let localBlock = "";
let localProjectRoot: string | null = null;

if (profile.cwd) {
  const resolved = this.resolveProjectRoot(profile.cwd);
  if (resolved && resolved !== this.projectRoot) {
    // Save current DB identity
    const tunnelRoot = this.projectRoot;
    
    // Switch to child project DB
    this.ensureDb(resolved);
    localProjectRoot = resolved;
    
    // Collect local entries (same level, index-table format only)
    const localEntries: Record<string, string[]> = {};
    let localTotal = 0;
    const localDb = this.requireDb();
    for (const ns of namespaces) {
      const rows = localDb.prepare(
        `SELECT key FROM entries WHERE project_id = ? AND namespace = ? AND expired = 0 ORDER BY updated_at DESC`
      ).all(this.projectId(), ns) as Array<{ key: string }>;
      const keys = rows.map((r) => r.key);
      localEntries[ns] = keys;
      localTotal += keys.length;
    }
    
    // Build local index table
    if (localTotal > 0) {
      const collapse = localTotal > 20;
      const lines: string[] = [
        `\n\n---\n\n以下记忆来自 ${localProjectRoot}（项目路径为 resolveProjectRoot(cwd) 结果），用 memory_get 按需读取：`,
        "",
        "| 命名空间 | 条目 | 建议 |",
        "|---------|------|------|",
      ];
      for (const ns of namespaces) {
        const keys = localEntries[ns];
        if (keys.length === 0) continue;
        const entryCell = collapse ? `(${keys.length} 条)` : keys.join(", ");
        lines.push(`| ${ns} | ${entryCell} | ${suggestionMap[ns] || "按需"} |`);
      }
      if (collapse) {
        lines.push("");
        lines.push(`总计 ${localTotal} 条，已折叠。使用 memory_get(namespace=命名空间路径, project="${localProjectRoot}") 读取具体内容。`);
      }
      lines.push("");
      lines.push(`调用格式: memory_get(namespace="project/meta", project="${localProjectRoot}")`);
      localBlock = lines.join("\n");
    }
    
    // Restore tunnel DB
    this.ensureDb(tunnelRoot!);
  }
}
```

- [ ] **步骤 2：修改全局层 `minimal` / `standard` / `full` 输出格式**

全局层（planning-hub 记忆）改为以 "## 全局上下文（来自 planning-hub）" 开头：

```typescript
// 全局层前缀
const globalHeader = totalEntries > 0 ? "## 全局上下文\n\n" : "";

// minimal 路径：
output = `${rolePrefix}${globalHeader}使用 memory_get(namespace="project/meta") 读取项目背景后开始工作。`;

// standard 路径：
output = `${rolePrefix}${globalHeader}使用 memory_get 按需读取：\n\n` + bulletLines.join("\n");

// full 路径：
output = `${rolePrefix}${globalHeader}以下记忆条目可用，请用 memory_get 按需读取：\n\n|...`;
```

- [ ] **步骤 3：在输出末尾追加本地层**

在所有输出构建完成后（handoff append 之后），追加 localBlock（需检查大小限制）：

```typescript
// --- Append local layer (NEW) ---
if (localBlock) {
  const currentBytes = Buffer.byteLength(output, "utf-8");
  const localBytes = Buffer.byteLength(localBlock, "utf-8");
  if (currentBytes + localBytes <= maxBytes) {
    output += localBlock;
  } else {
    // Truncated: append a brief note
    output += `\n\n---\n\n> 子项目记忆索引已省略（超出注入大小限制）。使用 memory_list(project="${localProjectRoot}") 手动浏览。`;
  }
}
```

- [ ] **步骤 4：空守卫更新**

当前空守卫（行 366-368）仅检查 `totalEntries === 0 && !handoffBlock`。需扩展考虑本地层：

```typescript
if (totalEntries === 0 && !handoffBlock && !localBlock) {
  return "[系统注入] 你是任务 session。当前无共享记忆条目。";
}
```

但如果只有本地层（全局空 + 无 handoff），应返回本地层：

```typescript
if (totalEntries === 0 && !handoffBlock && localBlock) {
  return `${rolePrefix}${localBlock}`;
}
```

**注意：** 此改动需要重新排列 `minimal/standard/full` 分支前面的空守卫逻辑。建议在收集完所有三层数据后再统一判空。

- [ ] **步骤 5：类型安全**

`profile.cwd` 在 `InjectionProfile` 中已是 `cwd?: string`，无需改 types.ts。

- [ ] **步骤 6：Commit**

```bash
git add src/memory-store.ts
git commit -m "feat: buildInjection 支持双层注入（全局 + 子项目本地层）"
```

---

### 任务 2：6 个 MCP 工具 — 添加 project 参数路由

**文件：**
- 修改：`src/tools/memory-get.ts:5-48`
- 修改：`src/tools/memory-set.ts:5-80`
- 修改：`src/tools/memory-list.ts:5-37`
- 修改：`src/tools/memory-delete.ts:5-48`
- 修改：`src/tools/memory-status.ts:4-33`
- 修改：`src/tools/memory-archive.ts:5-40`

**描述：** 每个 MCP 工具添加一个可选的 `project` 参数（absolute path string）。传了则 `resolveProjectRoot(project)` + `ensureDb(resolved)`；不传则 `ensureDb(tunnelProjectRoot)` 恢复默认 DB。

**通用 pattern（以 `memory-get.ts` 为例）：**

- [ ] **步骤 1：读取现有工具 handler 签名，添加 `project` 到 zod schema**

在 `memory-get.ts` 的 `server.tool(...)` 中 `include_expired` 参数之后、handler 之前，添加：

```typescript
project: z.string().optional().describe("目标项目的绝对路径（如 D:/code/project-a）。省略则使用当前项目。"),
```

- [ ] **步骤 2：在 handler body 开头插入 DB 路由逻辑**

在 `if (!memoryStore)` 检查之后、`try {` 之前：

```typescript
// Route to child project DB if specified
const { memoryStore, tunnelProjectRoot } = services;  // ← 已有，确认存在
if (project) {
  const resolved = memoryStore.resolveProjectRoot(project);
  if (!resolved) {
    return {
      content: [{ type: "text", text: `${project} 下未找到 .kimi-tunnel/ 目录` }],
      isError: true,
    };
  }
  memoryStore.ensureDb(resolved);
} else {
  // Restore default DB (previous call with project may have switched)
  memoryStore.ensureDb(tunnelProjectRoot);
}
```

- [ ] **步骤 3-8：对 6 个文件重复上述两步**

逐一修改：
- `src/tools/memory-get.ts` — 行 15 (handler 参数) + 行 17-21 之间插入路由
- `src/tools/memory-set.ts` — 行 17 (handler 参数) + 行 18-24 之间
- `src/tools/memory-list.ts` — 行 13 (handler 参数) + 行 13-22 之间
- `src/tools/memory-delete.ts` — 行 14 (handler 参数) + 行 14-22 之间
- `src/tools/memory-status.ts` — 行 10 (handler 参数) + 行 10-18 之间
- `src/tools/memory-archive.ts` — 行 15 (handler 参数) + 行 15-24 之间

**注意** `memory-status.ts` 和 `memory-archive.ts` 没有 zod 验证参数，需完整添加 `project` zod 声明。

- [ ] **步骤 9：编译验证**

```bash
npm run build
```
预期：零错误。

- [ ] **步骤 10：Commit**

```bash
git add src/tools/memory-get.ts src/tools/memory-set.ts src/tools/memory-list.ts src/tools/memory-delete.ts src/tools/memory-status.ts src/tools/memory-archive.ts
git commit -m "feat: 6 个 memory_* MCP 工具添加 project 参数支持跨项目路由"
```

---

### 检查点：任务 1-2 之后

- [ ] `npm run build` 零错误
- [ ] 代码审查确认：
  - `buildInjection` 末尾 DB 切回 tunnelProjectRoot
  - 每个 MCP 工具的 `else` 分支显式 `ensureDb(tunnelProjectRoot)`
  - handoff 收集在 DB 切换之前
  - `resolveProjectRoot` 处理子目录路径
  - 本地层标签使用解析后的 root 而非原始 cwd
  - 同项目跳过（`resolved !== this.projectRoot`）

---

### 任务 3：端到端验证脚本

**文件：**
- 创建：`tests/cross-project-memory/test-scenario.sh`

**描述：** 创建测试场景脚本，验证双层注入行为。

- [ ] **步骤 1：创建测试目录结构**

```bash
mkdir -p tests/cross-project-memory/planning-hub/.kimi-tunnel
mkdir -p tests/cross-project-memory/project-a/.kimi-tunnel
```

- [ ] **步骤 2：写入 planning-hub 全局记忆**

在 Tunnel 启动后通过 `memory_set` 写入：
```json
// memory_set(namespace="project/decisions", key="di_pattern", value="所有模块使用 DI 模式")
// memory_set(namespace="project/learnings", key="server_oom", value="Kimi Server ~20h OOM")
```

- [ ] **步骤 3：写入 project-a 本地记忆**

```json
// memory_set(namespace="project/meta", key="tech_stack", value="React 18 + Vite 5", project=".../project-a")
// memory_set(namespace="project/meta", key="conventions", value="使用 Tailwind CSS", project=".../project-a")
```

- [ ] **步骤 4：验证注入文本格式**

手动调用 `memoryStore.buildInjection({ level: "standard", maxBytes: 8192, cwd: ".../project-a" })` 或通过 `create_session(cwd=".../project-a")` + `execute_prompt` 观察注入内容。

预期输出包含：
```
## 全局上下文
- memory_get(namespace="project/decisions") — 相关决策（必读）
- memory_get(namespace="project/learnings") — 经验沉淀（按需）

---

以下记忆来自 .../project-a（项目路径为 resolveProjectRoot(cwd) 结果），用 memory_get 按需读取：
| 命名空间 | 条目 | 建议 |
| project/meta | tech_stack, conventions | 必读 |

调用格式: memory_get(namespace="project/meta", project=".../project-a")
```

- [ ] **步骤 5：测试 project 参数路由**

```
memory_get(namespace="project/meta", project=".../project-a") → 返回 project-a 条目
memory_get(namespace="project/meta") → 返回 planning-hub 条目（行为不变）
memory_get(namespace="project/meta", project=".../no-kimi-tunnel") → 返回错误提示
```

- [ ] **步骤 6：构建确认**

```bash
npm run build
```
预期：零错误。

- [ ] **步骤 7：Commit**

```bash
git add tests/cross-project-memory/
git commit -m "test: 跨项目记忆双层注入验证脚本"
```

---

### 任务 4：更新 AGENTS.md 记录决策

**文件：**
- 修改：`AGENTS.md`（追加版本历史条目）

**描述：** 在 AGENTS.md 版本历史中添加本次变更记录。

- [ ] **步骤 1：在 AGENTS.md 注释区顶部添加版本条目**

```markdown
  2026-07-16 | kimi-code (feat) | 跨项目记忆双层注入：buildInjection() 消费 profile.cwd 生成双层注入文本（全局正文 + 子项目索引导航表）；6 个 memory_* MCP 工具添加 project 可选参数支持跨项目 DB 路由；else 分支显式 ensureDb(tunnelProjectRoot) 防状态泄漏
```

- [ ] **步骤 2：Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 记录跨项目记忆双层注入决策"
```

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `buildInjection` 重构引入回归 | 高 | 现有注入逻辑仅新增分支，不改动已有路径；空守卫兼容扩展 |
| `ensureDb` 频繁切换性能 | 低 | SQLite 轻量切换；同项目去重守卫；典型场景下每 session 切换 1-2 次 |
| DB 状态泄漏 | 中 | 每个 MCP 工具 `else` 显式恢复；`buildInjection` 末尾恢复；设计已覆盖 |
| 注入文本超 8192 限制 | 低 | 全局层优先完整，本地层截断 + 提示 |

## 待定问题

- 无需人为输入的问题。范围、方案、实现细节均已明确。
