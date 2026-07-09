<!--
修改记录:
  2026-07-08 | kimi-code (v2.6) | 实施 004-memory-lazy-inject：注入策略升级——全量预载 → 索引+按需自读（minimal/standard/full 三级）；角色锚定"你是任务 session"；>20条自动折叠；注入文本 ~600B→~200B；Live test 通过
  2026-07-08 | kimi-code (v2.5) | 实施 002-session-memory-share：三层共享内存系统——MemoryStore（node:sqlite 零依赖）+ 8个MCP工具（memory_*）+ 自动注入（create_session/execute_prompt）
  2026-07-07 | kimi-code (v2.4) | 实施 003-permission-policy：三层权限系统——策略引擎 + 工具级拦截 + 3内置策略 + 自定义YAML + 3新MCP工具（list_policies/approve_tool/deny_tool）；工具总数 19→22；selftest通过
  2026-07-07 | kimi-code (v2.3) | PM Dashboard 重写 + 监控页面升级；coordinator-guide v2.3（PM范式/Skill调度/注意力管理/越权控制）；2个新spec（002/003）；竞品分析+系统调研
  2026-07-07 | kimi-code (fix) | sanitizeText 反斜杠预加固 + maxContentLength 参数：防御 hex escape 错误，解决审计报告截断
  2026-07-06 | kimi-code (robustness) | WireClient 新增心跳探测+自动重连：每10s ping /api/v1/meta，连续3次无响应→标记断连→自动重连；解决 Kimi web 静默崩溃后状态假活问题
  2026-07-06 | kimi-code (arch) | 后台监听最佳方案确定为 Bash REST 轮询（OS信号驱动），set_watch_output 降为备选；工具总数 18
  2026-07-06 | kimi-code (feature) | watch_session/get_watch_result/continue_watch/set_watch_output 4工具: WS后台监听+自动化循环+文件输出
  2026-07-06 | kimi-code (feature) | 自适应工作流引擎：learn/execute/list/continue_workflow 4工具 + 模板存储 + 监管页面
  2026-07-06 | kimi-code (architecture) | 架构深化：消除 9 文件 584 行死代码，拆分 session-manager 为 store+reader，消除 3 个单例为 DI
  2026-07-06 | kimi-code (tools) | 新增 3 个 MCP 工具（list_io_records/create_session/poll_session），总计 10 工具；execute_prompt/chat_with_session 新增 auto_mode + wait 参数
  2026-07-06 | kimi-code (bugfix) | 修复 EADDRINUSE 多 session 冲突：http-server.ts 添加双重错误处理避免 MCP 崩溃
  2026-07-05 | FirenzeClaw            | 初始版本
-->

# Kimi Session Orchestrator

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v2.6-brightgreen)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-28-orange)]()

Kimi Code CLI 的 PM 视角多 session 编排系统——28 个 MCP 工具，支持自适应工作流引擎 + 三层共享内存 + 权限策略管理。

## 架构

```
外部用户 (浏览器 / curl)
    ↕ HTTP + WebSocket (端口 3456)
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
│   Kimi Server (kimi web)    │  端口 5494
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
# 1. 启动 Kimi Server（⚠️ --port 5494 在 Linux 上必须显式指定，否则随机端口导致无法连接）
kimi web --no-open --port 5494

# 2. 设置 token（Kimi Server 启动时打印）
export KIMI_SERVER_TOKEN="your-token-here"

# 3. 启动 Tunnel
npm start
```

Tunnel 启动后自动连接 Kimi Server，选择最近 session，初始化记忆库（如 `.kimi-tunnel/` 存在）。

> **平台差异**：Windows 上 `kimi web --no-open` 默认固定端口 5494，`--port` 可省略。**Linux 上默认随机端口，因此 `--port 5494` 是必须的**，否则 orchestrator 无法找到 Kimi Server。若启动后需要恢复连接，tunnel 会每 10s 自动重试。

### 注册到 Kimi Code CLI

在 `~/.kimi-code/mcp.json` 中添加（路径按实际安装位置调整）：

```json
{
  "mcpServers": {
    "kimi-session-orchestrator": {
      "command": "node",
      "args": ["<项目绝对路径>/dist/index.js"],
      "env": {
        "KIMI_SERVER_TOKEN": "your-token-here",
        "KIMI_SERVER_URL": "http://127.0.0.1:5494"
      }
    }
  }
}
```

> **注意**：Linux 上 `KIMI_SERVER_URL` 必须显式设置（默认 `http://127.0.0.1:5494`），确保与 `kimi web --port` 一致。

然后 `/reload` 即可使用。

### 安装 Skill

```bash
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator
```

新 session 加载 skill 后自动触发 PM 启动协议——读取 coordinator-guide 建立基线，询问角色、目标和决策模式。详见 [Linux 部署 → 安装 PM Skill](#安装-pm-skill)。

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
| `/` | GET | Web 调试控制台 (v2.3) |
| `/workflow-console.html` | GET | PM Dashboard — Session 健康监控、注意力预警、Skill 调度日志 |
| `/api/status` | GET | 隧道状态 |
| `/api/execute` | POST | 发送 prompt 并等待回复 |
| `/api/send` | POST | 发送 prompt 并等待回复（与 /api/execute 相同机制） |
| `/ws` | WebSocket | 实时双向通信 |

### 示例

```bash
curl -X POST http://localhost:3456/api/execute \
  -H "Content-Type: application/json" \
  -d '{"prompt":"写一个 Python hello world","timeout_ms":60000}'
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
```

> **v2.7 变更**：`src/public/console.html` 和 `workflow-console.html` 已移除。监控 UI 迁移至浏览器扩展 + JS 脚本插件，直接注入 Kimi Web UI 侧边栏。

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
  memory_set(ns, key, value)         → 收到索引 → memory_get(ns)
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
| `docs/coordinator-guide.md` | 统筹 Session 准入规范（PM视角 v2.6） |
| `docs/issues/memory-init-timing.md` | [FIXED] MemoryStore 启动初始化缺陷 |
| `docs/issues/memory-cross-project-injection.md` | [FIXED] 跨项目注入静默失效 |
| `specs/001-adaptive-workflow-engine/` | 自适应工作流引擎 [DONE] |
| `specs/002-session-memory-share/` | Session 冷启动记忆共享 [DONE] |
| `specs/003-permission-policy/` | 权限与策略管理 [DONE] |
| `specs/004-memory-lazy-inject/` | 记忆注入策略升级——索引+按需自读 [DONE] |
| `specs/005-web-ui-extension/` | Kimi Web UI 编排监控插件——浏览器扩展+JS脚本双版本 |

## Linux 部署

### 前置条件

```bash
node -v   # ≥ 22
kimi --version  # ≥ 0.22.3
```

### 一键部署

```bash
git clone https://github.com/FirenzeClaw/kimi-session-orchestrator.git
cd kimi-session-orchestrator
npm install && npm run build
```

### 启动

```bash
# 终端 1: Kimi Server（⚠️ Linux 上 --port 5494 是必须的，不可省略）
kimi web --no-open --port 5494
# 记下输出的 Token

# 终端 2: Tunnel
export KIMI_SERVER_TOKEN="<token>"
npm start
```

### 注册 MCP

```bash
mkdir -p ~/.kimi-code

cat > ~/.kimi-code/mcp.json << 'EOF'
{
  "mcpServers": {
    "kimi-session-orchestrator": {
      "command": "node",
      "args": ["/home/user/kimi-session-orchestrator/dist/index.js"],
      "env": {
        "KIMI_SERVER_TOKEN": "<token>",
        "KIMI_SERVER_URL": "http://127.0.0.1:5494"
      }
    }
  }
}
EOF
```

> **注意**：`args` 中的路径需为绝对路径，按实际 clone 位置调整。`KIMI_SERVER_URL` 必须与 `kimi web --port` 一致（Linux 上默认为随机端口，必须显式指定）。`/reload` 后生效。

### 安装 PM Skill

将 skill 注册到 Agent 系统（skill 加载时自动读取 coordinator-guide 并询问 PM 模式）：

```bash
# 复制 skill 目录（含 SKILL.md + coordinator-guide.md）
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator

# 新 session 自动加载，触发 PM 启动协议：
#   ① 读取 coordinator-guide 建立规范基线
#   ② 询问角色（PM/执行）+ 目标 + 决策模式（自主/等待）
```

### 构建脚本 Linux 兼容

项目 `package.json` 的 build 脚本使用 `cp -r`，兼容 Linux。若 `dist/public/` 不存在：

```bash
mkdir -p dist/public && npm run build
```

### 兼容性确认

| 组件 | Linux | 备注 |
|------|:--:|------|
| `node:sqlite` | ✅ | Node 22+ 内置 |
| `path.join/dirname` | ✅ | 全项目使用跨平台 API |
| 文件路径 | ✅ | 统一 `replace(/\\/g, "/")` 归一化 |
| MCP stdio | ✅ | 标准协议 |
| Kimi Server CLI | ✅ | `kimi web` 跨平台 |
| Wire Client 重连 | ✅ | 启动失败后每 10s 自动重试（v2.6.1+），指数退避最长 ~63s |
| Kimi Server 端口 | ⚠️ | Linux 默认随机端口，**必须** `kimi web --port 5494` 或设置 `KIMI_SERVER_URL` |

## License

MIT
