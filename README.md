<!-- 修改记录见文末 §版本历史 -->

# Kimi Session Orchestrator

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v2.8-brightgreen)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-28-orange)]()

Kimi Code CLI 的 PM 视角多 session 编排系统——28 个 MCP 工具，支持自适应工作流引擎 + 三层共享内存 + 权限策略管理。

## 目录

- [架构](#架构)
- [快速开始](#快速开始)
  - [前置条件](#前置条件)
  - [安装](#安装)
  - [启动](#启动)
  - [环境变量](#环境变量)
  - [注册到 Kimi Code CLI](#注册到-kimi-code-cli)
  - [安装 Skill](#安装-skill)
  - [更新工具](#更新工具)
- [MCP 工具](#mcp-工具)
  - [Session 管理](#session-管理)
  - [任务下发](#任务下发)
  - [状态监控](#状态监控)
  - [共享记忆](#共享记忆v25)
  - [工作流模板](#工作流模板)
  - [权限策略](#权限策略)
  - [推送](#推送)
- [REST API](#rest-api)
- [项目结构](#项目结构)
- [共享记忆系统](#共享记忆系统v25)
- [权限策略系统](#权限策略系统v24)
- [参考文档](#参考文档)
- [Linux 部署](#linux-部署)
- [常见问题 (FAQ)](#常见问题-faq)
- [参与贡献](#参与贡献)
- [版本历史](#版本历史)
- [License](#license)

## 架构

```
外部用户 (浏览器 / curl)
    ↕ HTTP + WebSocket (默认 3456，通过 TUNNEL_PORT 配置)
┌──────────────────────────────┐
│   kimi-session-orchestrator MCP 服务器 │
│   ├─ Express HTTP Server      │
│   ├─ WebSocket Server         │
│   ├─ WireClient (REST + WS推送 + 心跳重连) │
│   ├─ WorkflowEngine (自适应工作流)      │
│   ├─ PolicyEngine (权限策略引擎)       │
│   ├─ MemoryStore (SQLite 共享记忆)     │
│   └─ MCP stdio transport      │
└─────────────┬────────────────┘
              ↕ Bearer Token REST API
┌─────────────────────────────┐
│   Kimi Server (kimi web)    │  端口自动检测
│   POST /api/v1/sessions/... │
└─────────────────────────────┘
```

## 快速开始

### 前置条件

- **Node.js ≥ 22**（`node:sqlite` 内置模块要求）
- Kimi Code CLI ≥ 0.22.3
- Git Bash（Windows）或 bash（Linux/macOS）

### 安装

```bash
git clone https://github.com/FirenzeClaw/kimi-session-orchestrator.git
cd kimi-session-orchestrator
npm install
npm run build
```

### 启动

```bash
# 1. 启动 Kimi Server（Tunnel 自动从 ~/.kimi-code/server/lock 检测端口，无需显式指定 --port）
kimi web --no-open

# 2. 设置 token（Kimi Server 启动时打印）
export KIMI_SERVER_TOKEN="your-token-here"

# 3. 启动 Tunnel
npm start
```

Tunnel 启动后自动连接 Kimi Server，选择最近 session，初始化记忆库（如 `.kimi-tunnel/` 存在）。

> **端口自动检测**：Tunnel 启动时自动读取 `~/.kimi-code/server/lock` 获取 Kimi Server 实际端口，无需再手动设置 `KIMI_SERVER_URL` 或 `--port`。如需覆盖，仍可通过 `KIMI_SERVER_URL` 环境变量指定。

### 注册到 Kimi Code CLI

在 `~/.kimi-code/mcp.json` 中添加（路径按实际安装位置调整）：

```json
{
  "mcpServers": {
    "kimi-session-orchestrator": {
      "command": "node",
      "args": ["<项目绝对路径>/dist/index.js"],
      "env": {
        "KIMI_SERVER_TOKEN": "your-token-here"
      }
    }
  }
}
```

> **注意**：`KIMI_SERVER_URL` 无需设置——Tunnel 自动从 lock 文件检测端口。仅在需要覆盖自动检测时才显式设置。

然后 `/reload` 即可使用。

### 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|:--:|--------|------|
| `KIMI_SERVER_TOKEN` | ✅ 是 | — | Kimi Server 启动时打印的 Bearer Token |
| `KIMI_SERVER_URL` | 否 | 自动检测 | 覆盖 Kimi Server 地址，如 `http://127.0.0.1:5494` |
| `TUNNEL_PORT` | 否 | `3456` | Tunnel HTTP/WebSocket 监听端口 |
| `KIMI_CODE_HOME` | 否 | `~/.kimi-code` | Kimi Code CLI 数据目录（含 server/lock、sessions/） |

### 安装 Skill

```bash
# Agent 级 skill（新 session 自动加载）
rm -rf ~/.agents/skills/kimi-session-orchestrator
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator

# PM 专用 skill（退役与接班自动化 pipeline）
rm -rf ~/.kimi-code/skills/session-retire
cp -r skills/session-retire ~/.kimi-code/skills/session-retire
```

新 session 加载 skill 后自动触发 PM 启动协议——读取 coordinator-guide 建立基线，询问角色、目标和决策模式。`/reload` 后生效。详见 [Linux 部署 → 安装 PM Skill](#安装-pm-skill)。

### 更新工具

拉取最新代码后，执行以下步骤使更新生效：

```bash
git pull
npm run build                              # 重新编译 TypeScript

# 更新 Agent 级 skill（含 coordinator-guide）
rm -rf ~/.agents/skills/kimi-session-orchestrator
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator

# 更新 PM 级 skill
rm -rf ~/.kimi-code/skills/session-retire
cp -r skills/session-retire ~/.kimi-code/skills/session-retire
```

> **重要**：更新后必须在 Kimi Code CLI 中执行 `/reload` 使 MCP 工具和 skill 变更生效。仅 `git pull` + `npm run build` 不更新 skill 文件时，`/reload` 即可——MCP 工具指向 `dist/index.js`，重新编译后自动生效。

## MCP 工具

### Session 管理

| 工具 | 描述 |
|------|------|
| `create_session` | 创建新 session，支持 cwd/permission_mode/memory_level/from_session/policy |
| `list_sessions` | 列出所有 session（按更新时间倒序） |
| `get_session_info` | 查看 session 详情（含 wire.jsonl 路径、标题、cwd） |
| `get_tunnel_status` | Wire 连接状态、客户端数、运行时间、WS 连接状态 |

### 任务下发

| 工具 | 描述 |
|------|------|
| `execute_prompt` | 发送 prompt（即发即返），支持 auto_mode/thinking/policy/skip_memory |
| `chat_with_session` | 向已有 session 发送任务（即发即返） |
| `run_flow` | 多步流程：创建 session → 逐步下发 → 自动等待每步完成 |
| `execute_workflow` | 执行工作流模板：加载模板 → 自动驱动 → 自适应调整 |
| `continue_workflow` | 对暂停的工作流执行决策（retry/skip/abort/manual） |

### 状态监控

| 工具 | 描述 |
|------|------|
| `poll_session` | 结构化轮询 session 状态（WS 缓存优先，active/swarm/awaiting/done/error/idle） |
| `list_io_records` | 快速提取 prompt ↔ 回复（过滤 tool_call/thinking 噪音） |
| `read_session_log` | 读取完整对话日志，支持分页和增量 |
| `watch_session` | WS 后台监听，主动等待 session 完成 |
| `get_watch_result` | 获取后台监听结果（非阻塞） |
| `continue_watch` | 拿结果 + 发下一步 + 启动新监听 |

### 共享记忆（v2.5+）

| 工具 | 描述 |
|------|------|
| `memory_set` | 写入键值对到命名空间，自动版本递增 |
| `memory_get` | 读取条目，支持 namespace/key 过滤 + 过期条目 |
| `memory_list` | 列出命名空间键名（前缀匹配） |
| `memory_delete` | 删除指定条目 |
| `memory_status` | 知识库全景：条目数、命名空间分布、最后更新 |
| `memory_archive` | 将 session L2 findings 归档为 L1 learnings |

> **v2.6 注入策略**：`create_session(memory_level)` 自动注入**记忆索引**（命名空间 + 键名 + 读取建议），task session 首 turn 自主调用 `memory_get` 按需拉取。注入文本从 ~600B 降至 ~200B。

### 工作流模板

| 工具 | 描述 |
|------|------|
| `learn_workflow` | 从描述或历史 session 学习工作流，生成 YAML 模板 |
| `list_templates` | 列出可用模板（名称、版本、步骤数） |

### 权限策略

| 工具 | 描述 |
|------|------|
| `list_policies` | 列出内置 + 自定义策略，含验证状态 |
| `approve_tool` | PM 放行被阻断的工具调用（once/session scope） |
| `deny_tool` | PM 拒绝被阻断的工具调用 |

### 推送

| 工具 | 描述 |
|------|------|
| `stream_response` | 实时推送结果到所有 WebSocket 调试客户端 |
| `set_watch_output` | 设置监听结果文件路径，完成后自动写入 |

## REST API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/status` | GET | 隧道状态：wire 连接、客户端数、运行时间 |
| `/api/orchestrations` | GET | PM→子 session 编排关系列表 |
| `/api/token` | GET | 获取 Kimi Server Token（仅限 localhost 访问） |
| `/api/execute` | POST | 发送 prompt 并等待回复 |
| `/api/send` | POST | 发送 prompt 并等待回复（与 /api/execute 相同机制） |
| `/ws` | WebSocket | 实时双向通信 |

### 示例

```bash
# 端口默认 3456，也可通过 TUNNEL_PORT 设置
curl -X POST http://localhost:${TUNNEL_PORT:-3456}/api/execute \
  -H "Content-Type: application/json" \
  -d '{"prompt":"你的 prompt","timeout_ms":60000}'
```

## 智能思考过滤

- **默认**：排除思考链内容，仅返回文本回复
- **自动触发**：当回复含"不确定/可能/需要更多"等模糊词时，自动读取思考内容确认意图
- **手动**：设置 `include_thinking: true` 强制包含

## 项目结构

```
src/
├── index.ts                     # 入口：DI 装配，启动 HTTP+MCP，初始化记忆库和编排追踪
├── types.ts                     # TunnelServices 接口
├── mcp-server.ts                # MCP stdio 服务器（注册 28 个工具）
├── http-server.ts               # Express + WebSocket + /api/orchestrations + /api/token
├── wire-client.ts               # Kimi Server REST + WS 推送 + 心跳探测自动重连
├── message-queue.ts             # WebSocket pub/sub 广播
├── orchestration-store.ts       # PM→子 session 编排关系内存追踪
├── session-store.ts             # 文件系统扫描 + 路径解析
├── session-log-reader.ts        # wire.jsonl 日志解析 + IO 提取 + sanitizeText
├── workflow-template.ts         # 模板类型定义 + YAML 解析 + Zod 校验
├── workflow-store.ts            # 模板持久化（templates/ CRUD）
├── workflow-engine.ts           # 自适应工作流引擎
├── policy-types.ts              # 策略类型 + Zod schema + 已知工具清单
├── policy-builtins.ts           # read-only / safe-edit / full-access
├── policy-store.ts              # YAML 策略文件 CRUD
├── policy-engine.ts             # 策略解析/检查/绑定 + BlockEvent 追踪
├── memory-store.ts              # SQLite 持久化 + buildInjection()
├── memory-injector.ts           # 注入文本构建（thin wrapper）
├── tools/                       # 28 个 MCP 工具
│   ├── create-session.ts        # + 编排追踪
│   ├── run-flow.ts              # + 编排追踪
│   ├── execute-workflow.ts      # + 编排追踪
│   └── ...

shared/                          # 浏览器端共享 JS（ES2020+）
├── api.js                       # Tunnel + Kimi Server API 客户端
├── state.js                     # Session 树状态管理
├── renderer.js                  # DOM 渲染（复用页面原生样式）
├── injector.js                  # DOM 注入 + token 自动填入
└── styles.css                   # 最小注入样式

ext/                             # Chrome MV3 扩展
├── manifest.json                # content_scripts → Kimi Web UI 页面
├── content.js                   # 扩展入口
├── service-worker.js
├── options.html                 # 端口配置页
├── options.js
└── icons/

userscript/                      # Tampermonkey 用户脚本源
└── （构建输出到 dist/userscript/）

scripts/
└── build-userscript.mjs         # 共享代码内联 → .user.js

skills/                          # 配套 Skill（4 个）
├── kimi-session-orchestrator/   # Agent 级——MCP 工具使用规范
├── session-retire/              # PM 级——退役与接班自动化 pipeline（v2.7 新增）
├── agent-session-monitor.md     # wire.jsonl 状态推断
└── mcp-async-tool.md            # 异步工具设计模式
```

> **v2.7 变更**：`src/public/console.html` 和 `workflow-console.html` 已移除。监控 UI 迁移至浏览器扩展 + JS 脚本插件，直接注入 Kimi Web UI 侧边栏。新增 `session-retire` skill——退役→接班自动化 pipeline（memory_archive + 7-block 模板 + 新 session 启动自举协议）。
>
> **v2.8 变更**：`buildInjection()` 注入文本 `memory_get("ns")` → `memory_get(namespace="ns")`——消除工具名歧义；REST API 端点删过时补漏（移除已删除的 `/` 和 `/workflow-console.html`，补充 `/api/orchestrations`、`/api/token`）；新增"更新工具"章节；全文档过时内容清理。

## 共享记忆系统（v2.5+）

```
┌─────────────────────────────────────────────────┐
│ L1: 项目知识库 (.kimi-tunnel/memory.db)          │
│ PM 一次性录入 → task session 启动时自动注入索引    │
│ project/meta / decisions / risks / learnings    │
├─────────────────────────────────────────────────┤
│ L2: Session 上下文 (session:<id>/*)             │
│ 创建时写入，运行时更新，退役后归档                  │
├─────────────────────────────────────────────────┤
│ L3: 学习沉淀 (learn skill → 向量库)              │
│ 从 L1+L2 提取可复用模式                          │
└─────────────────────────────────────────────────┘

PM 操作:                            Task session 首 turn:
  memory_set(ns, key, value)         → 收到索引 → memory_get(namespace=ns)
  create_session(memory_level=full)  → 评估关联 → 拉取条目 → 执行任务
  execute_prompt(task)               → 同一 turn 完成上下文建立 + 工作
```

## 权限策略系统（v2.4+）

- **三层架构**：Session 级策略（create_session policy 参数） + 任务级策略（execute_prompt policy 参数） + 工具级拦截（WireClient approveAll）
- **3 内置策略**：`read-only`（只读）/ `safe-edit`（安全编辑，禁 shell 命令）/ `full-access`（全部允许）
- **自定义 YAML**：`.kimi-tunnel/policies/<name>.yaml`
- **PM Dashboard**：实时阻断事件面板，支持 approve/deny（once/session scope）

## 参考文档

| 文档 | 用途 |
|------|------|
| `API.md` | Kimi Server REST API 完整参考 |
| `docs/coordinator-guide.md` | 统筹 Session 准入规范（PM视角 v2.8） |
| `docs/issues/memory-init-timing.md` | [FIXED] MemoryStore 启动初始化缺陷 |
| `docs/issues/memory-cross-project-injection.md` | [FIXED] 跨项目注入静默失效 |
| `specs/001-adaptive-workflow-engine/` | 自适应工作流引擎 [DONE] |
| `specs/002-session-memory-share/` | Session 冷启动记忆共享 [DONE] |
| `specs/003-permission-policy/` | 权限与策略管理 [DONE] |
| `specs/004-memory-lazy-inject/` | 记忆注入策略升级——索引+按需自读 [DONE] |
| `specs/005-web-ui-extension/` | Kimi Web UI 编排监控插件——浏览器扩展+JS脚本双版本 |

## Linux 部署

前置条件、安装、启动、MCP 注册、Skill 安装与上方 [快速开始](#快速开始) 完全一致。以下仅补充 Linux 特有的注意事项。

### 注册 MCP（Linux 路径示例）

```bash
mkdir -p ~/.kimi-code

cat > ~/.kimi-code/mcp.json << 'EOF'
{
  "mcpServers": {
    "kimi-session-orchestrator": {
      "command": "node",
      "args": ["/home/user/kimi-session-orchestrator/dist/index.js"],
      "env": {
        "KIMI_SERVER_TOKEN": "<token>"
      }
    }
  }
}
EOF
```

> `args` 中的路径需为绝对路径，按实际 clone 位置调整。`/reload` 后生效。

### 构建兼容性

项目 `package.json` 的 build 脚本使用 `cp -r`，兼容 Linux。

### 平台兼容性

| 组件 | Linux | 备注 |
|------|:--:|------|
| `node:sqlite` | ✅ | Node 22+ 内置 |
| `path.join/dirname` | ✅ | 全项目使用跨平台 API |
| 文件路径 | ✅ | 统一 `replace(/\\/g, "/")` 归一化 |
| MCP stdio | ✅ | 标准协议 |
| Kimi Server CLI | ✅ | `kimi web` 跨平台 |
| Wire Client 重连 | ✅ | 启动失败后每 10s 自动重试，指数退避最长 ~63s |
| Kimi Server 端口 | ✅ | 自动从 `~/.kimi-code/server/lock` 检测 |

## 常见问题 (FAQ)

<details>
<summary><b>为什么 task session 调用 <code>memory_get</code> 失败？</b></summary>

检查两点：
1. task session 的 `mcp.json` 是否注册了 `kimi-session-orchestrator` MCP 服务器
2. 注入文本中的工具调用应使用 `memory_get(namespace="project/meta")` 格式（命名参数），而非 `memory_get("project/meta")`（位置参数）——后者可能与其他 MCP 服务器的同名工具混淆
</details>

<details>
<summary><b>Tunnel 启动后报 "Wire client not connected"？</b></summary>

1. 确认 Kimi Server 正在运行：`kimi web --no-open`
2. 确认 `KIMI_SERVER_TOKEN` 已正确设置
3. Tunnel 会在启动失败后每 10s 自动重试连接，等待 1-2 分钟即可
</details>

<details>
<summary><b>更新代码后 Skill 没有生效？</b></summary>

仅 `git pull` + `npm run build` 不更新 skill 文件。Skill 是独立拷贝到用户目录的，需要手动重装：

```bash
rm -rf ~/.agents/skills/kimi-session-orchestrator
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator
```

然后 `/reload`。
</details>

<details>
<summary><b>端口被占用（默认 3456）？</b></summary>

设置 `TUNNEL_PORT` 环境变量更换端口，MCP stdio 功能不受影响。

```bash
export TUNNEL_PORT=3457
npm start
```
</details>

## 参与贡献

- **Bug 报告 / 功能请求**：[GitHub Issues](https://github.com/FirenzeClaw/kimi-session-orchestrator/issues)
- **代码贡献**：Fork → Feature Branch → Pull Request。提交前确保 `npm run build` 零错误。
- **文档规范**：参考 `docs/coordinator-guide.md` 了解项目约定。

## 版本历史

| 日期 | 版本 | 变更 |
|------|:--:|------|
| 2026-07-11 | v2.8 | 修复注入文本歧义：`memory_get("ns")` → `memory_get(namespace="ns")`；全文档过时清理 + TOC + 环境变量表 + FAQ + 贡献指南 |
| 2026-07-09 | v2.7 | 新增 `session-retire` skill：退役→接班自动化 pipeline；PM Dashboard 迁移至浏览器扩展 |
| 2026-07-08 | v2.6 | 记忆注入策略升级：全量预载 → 索引+按需自读（三级格式）；注入文本 ~600B→~200B |
| 2026-07-08 | v2.5 | 三层共享内存系统：MemoryStore + 6 个 memory_* MCP 工具 + 自动注入 |
| 2026-07-07 | v2.4 | 三层权限系统：策略引擎 + 3 内置策略 + 自定义 YAML |
| 2026-07-07 | v2.3 | PM Dashboard 重写；coordinator-guide v2.3（PM 范式/Skill 调度/注意力管理） |
| 2026-07-06 | v2.0 | 自适应工作流引擎；即发即返模式；WS 状态缓存 |
| 2026-07-05 | v1.0 | 初始版本 |

## License

MIT
