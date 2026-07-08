# 记忆注入跨项目失效：resolveProjectRoot 作用域限制

**状态**: 已修复 (2026-07-08)  
**修复方式**: 方案 A（全局记忆库）——`TunnelServices` 新增 `tunnelProjectRoot`，所有注入路径统一使用 tunnel 项目根定位 memory.db，不再依赖 session cwd 的 `.kimi-tunnel/` 查找  
**修复文件**: types.ts (+tunnelProjectRoot), index.ts (计算并存储), create-session.ts, execute-prompt.ts, chat-with-session.ts (替换 resolveProjectRoot→tunnelProjectRoot)  
**发现日期**: 2026-07-08  
**严重度**: P0（功能阻断——核心用例失败）  
**影响范围**: 所有 `memory_level != "off"` 的 session 注入路径

---

## 问题概述

`MemoryStore.resolveProjectRoot(cwd)` 从 session 的 `cwd` 向上遍历查找 `.kimi-tunnel/` 目录。当任务 session 的工作目录不在 tunnel 项目树下时（典型场景：PM 管理多个独立项目），注入静默跳过——session 收不到任何共享记忆。

---

## 复现

```
1. Tunnel 项目: D:/code/kimi-debug-tunnel/.kimi-tunnel/memory.db  ← 记忆数据在此
2. PM 创建 session: create_session(cwd=D:/code/other-project, memory_level=full)
3. PM 发送任务: execute_prompt(session_id, "...")
4. 预期: session 收到项目共享知识的注入前缀
5. 实际: session 收到原始 prompt，无任何注入
```

**复现结果**：先前对比测试中，注入 session（cwd=`D:/code/test`）的 `totalLines` 仅 36，而手动 session（手动嵌入相同上下文）为 65。注入 session 读取 3 个文件"了解编码规范"——因为它从未收到记忆上下文。

---

## 根因

### 调用链

```
create_session(cwd)                execute_prompt(session_id, prompt)
  │                                     │
  ├─ resolveProjectRoot(cwd)            ├─ getMemoryProfile(session_id)
  │    D:/code/test                     │    → 有 profile？
  │    → D:/code/test/.kimi-tunnel/ ❌  │
  │    → D:/code/.kimi-tunnel/      ❌  │    ├─ resolveProjectRoot(profile.cwd)
  │    → 返回 null                      │    │  又走一次向上查找
  │                                     │    │  同样找不到 → 返回 null
  │    → ensureDb 不执行                │    │
  │    → setMemoryProfile 不执行 ───────│────┤  profile.level 虽是 "full"
  │                                     │    │
  └─ 返回 session_id                    │    └─ buildInjection 不执行
                                        │       effectivePrompt = 原始 prompt
                                        └─ 提交，无注入
```

**关键代码**：`src/tools/create-session.ts:89-91`

```typescript
const projectRoot = services.memoryStore.resolveProjectRoot(cwd);
if (projectRoot) {
  services.memoryStore.ensureDb(projectRoot);
  // ... setMemoryProfile only if projectRoot was found
}
```

如果 `resolveProjectRoot` 返回 `null`，整条注入链断裂——无 DB 初始化、无 profile 存储、`execute_prompt` 中 `getMemoryProfile` 也返回 `null`。

### 设计矛盾

| 组件 | 作用域 | 含义 |
|------|--------|------|
| `memory.db` | **Tunnel 项目级**（`.kimi-tunnel/` 所在目录） | 一个 tunnel 实例管理一个项目的知识库 |
| `create_session(cwd)` | **任意路径** | PM 可以管理任意位置的多个项目 |
| `resolveProjectRoot(cwd)` | 从 cwd 向上查 `.kimi-tunnel/` | 假设 session cwd 与 memory 在同一目录树 |

**PM 的真实工作模式是管理多个独立项目**（例如同时维护 `D:/code/project-a`、`D:/code/project-b`、`D:/code/kimi-debug-tunnel`），但记忆注入要求每个项目各有自己的 `.kimi-tunnel/`——这与当前 tunnel 为**单项目**设计的架构冲突。

---

## 影响评估

| 场景 | 结果 |
|------|------|
| PM 管理 tunnel 自身项目 | ✅ 注入正常（cwd 在同一树下） |
| PM 管理其他项目（如 `D:/code/test`） | ❌ 注入静默失败 |
| PM 同时管理多个项目 | ❌ 只有 tunnel 自身项目能注入 |
| 工作流引擎跨项目执行 | ❌ `execute_workflow(cwd=other)` 注入失效 |

**严重性**：这是记忆系统的核心用例——coordinator-guide §1.5.4 要求退役时通过 `md-update` ＋ `learn` 持久化经验，新建 session 时自动注入。如果注入对 tunnel 自身以外项目不生效，记忆系统的价值被限制在 tunnel 自身维护场景。

---

## 修复方案

### 方案 A：全局记忆库（推荐）

将 `memory.db` 放在 tunnel 的 `.kimi-tunnel/` 中，注入时始终使用 tunnel 项目根来解析，忽略 session cwd。

**变更点**：

1. `src/index.ts` 启动时确定 `tunnelProjectRoot` 并存储到 `TunnelServices`
2. `execute-prompt.ts` 和 `chat-with-session.ts` 中，改用 `tunnelProjectRoot` 调用 `ensureDb`，而非 `resolveProjectRoot(profile.cwd)`
3. `create-session.ts` 中同理

```typescript
// index.ts
const tunnelProjectRoot = memoryStore.resolveProjectRoot(process.cwd());
const services: TunnelServices = { 
  ..., 
  memoryStore, 
  tunnelProjectRoot  // 新增
};
```

```typescript
// execute-prompt.ts
const projectRoot = services.tunnelProjectRoot;  // 替换 resolveProjectRoot(profile.cwd)
if (projectRoot) {
  services.memoryStore.ensureDb(projectRoot);
  const injection = services.memoryStore.buildInjection({...});
  effectivePrompt = injection + "\n\n---\n\n" + prompt;
}
```

**优点**：
- 一个项目一个 tunnel 实例，一个全局记忆库——符合当前单项目架构
- session cwd 不再影响注入
- 改动量小，集中在 3 个文件

**缺点**：
- 失去了"每个项目独立记忆库"的能力——但当前架构本就不支持多项目

### 方案 B：多记忆库支持

允许 `create_session` 指定记忆库路径，或自动为每个 session cwd 创建独立的 `.kimi-tunnel/memory.db`。

**优点**：真正支持多项目独立记忆  
**缺点**：改动量大，需要记忆库的创建/切换/合并逻辑，当前需求不迫切

### 方案 C：注入时 fallback 到 tunnel 项目根

保留当前逻辑，但在 `resolveProjectRoot(profile.cwd)` 返回 `null` 时，fallback 到 tunnel 自身的 `tunnelProjectRoot`。

```typescript
let projectRoot = services.memoryStore.resolveProjectRoot(profile.cwd);
if (!projectRoot) {
  projectRoot = services.tunnelProjectRoot;  // fallback
}
```

**优点**：向后兼容，最小改动  
**缺点**：语义不清晰——不同项目的记忆混在一个库中

---

## 建议实施顺序

1. **P0** — 方案 A：全局记忆库，在 `TunnelServices` 中新增 `tunnelProjectRoot`，注入路径统一使用
2. **P2** — 方案 B：多记忆库支持，作为远期架构升级

---

## 验证方法

修复后，执行以下验证：

```bash
# 1. 在任意 cwd 创建 session（不在 tunnel 项目树下）
create_session(cwd=D:/code/other-project, memory_level=full)

# 2. 发送需要记忆才能回答的问题
execute_prompt(session_id, "根据项目共享知识，列出已知风险")

# 3. 通过 wire log 确认注入
read_session_log(session_id) → lastUserPrompt 开头应含 "[系统注入]"
```

预期：session 无需读取文件即可正确回答，且 `recentToolCalls` 为空。

---

## 参考

- `src/memory-store.ts:10-23` — `resolveProjectRoot` 实现
- `src/tools/create-session.ts:86-109` — 记忆 profile 设置（有条件跳过）
- `src/tools/execute-prompt.ts:83-110` — 注入文本拼接与提交
- `docs/issues/memory-init-timing.md` — 相关 issue：启动时 DB 未初始化
- 上次对比测试数据：注入 session `totalLines=36`（无注入）、手动 session `totalLines=65`（手动嵌入）
