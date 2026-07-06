<!--
修改记录:
  2026-07-06 | kimi-code (feature) | watch_session/get_watch_result/continue_watch 3工具: WS后台监听+自动化循环
  2026-07-06 | kimi-code (bugfix) | /auto注入移除、execute_prompt auto_mode 修复、WS推送集成、架构深化8项
  2026-07-06 | kimi-code (feature) | 自适应工作流引擎：learn/execute/list/continue_workflow 4工具 + 模板存储 + 监管页面
  2026-07-06 | kimi-code (architecture) | 架构深化：消除 9 文件 584 行死代码，拆分 session-manager 为 store+reader，消除 3 个单例为 DI
  2026-07-06 | kimi-code (tools) | 新增 3 个 MCP 工具（list_io_records/create_session/poll_session），总计 10 工具；execute_prompt/chat_with_session 新增 auto_mode + wait 参数
  2026-07-06 | kimi-code (bugfix) | 修复 EADDRINUSE 多 session 冲突：http-server.ts 添加双重错误处理避免 MCP 崩溃
  2026-07-05 | FirenzeClaw            | 初始版本
-->

# Kimi Debug Tunnel

基于 REST API 的 Kimi Code CLI 调试隧道——推送式全自动化 session 编排，无需轮询。

## 架构

```
外部用户 (浏览器 / curl)
    ↕ HTTP + WebSocket (端口 3456)
┌──────────────────────────────┐
│   kimi-debug-tunnel MCP 服务器 │
│   ├─ Express HTTP Server      │
│   ├─ WebSocket Server         │
│   ├─ WireClient (REST + WS推送)   │
│   ├─ SessionWatcher (后台监听)     │
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

- Node.js ≥ 18
- Kimi Code CLI ≥ 0.20.1

### 安装

```bash
git clone https://github.com/FirenzeClaw/kimi-debug-tunnel.git
cd kimi-debug-tunnel
npm install
npm run build
```

### 启动

```bash
# 1. 启动 Kimi Server
kimi web --no-open --port 5494

# 2. 设置 token（Kimi Server 启动时打印）
export KIMI_SERVER_TOKEN="your-token-here"

# 3. 启动 Tunnel
npm start
```

Tunnel 启动后自动连接 Kimi Server 并选择最近的 session。

### 注册到 Kimi Code CLI

在 `~/.kimi-code/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "kimi-debug-tunnel": {
      "command": "node",
      "args": ["C:/Users/FirenzeClaw/kimi-debug-tunnel/dist/index.js"],
      "env": {
        "KIMI_SERVER_TOKEN": "your-token-here"
      }
    }
  }
}
```

然后 `/reload` 即可使用。

## MCP 工具

| 工具 | 描述 |
|------|------|
| `execute_prompt` | 发送 prompt 并等待回复（支持 `auto_mode` + `wait` 即发即返） |
| `chat_with_session` | 全自动多轮编排，支持 `auto_mode` + `wait` 即发即返 |
| `create_session` | 创建新 session，支持指定工作目录和权限模式（auto/manual/yolo） |
| `list_sessions` | 列出所有 session |
| `get_session_info` | 查看 session 详情（含 wire.jsonl 路径） |
| `read_session_log` | 读取对话日志，支持分页和增量读取 |
| `list_io_records` | 快速提取输入输出记录，过滤工具调用/思考链噪音 |
| `poll_session` | 结构化轮询 session 运行状态（active/swarm/awaiting/done/error/idle） |
| `run_flow` | 分步流程执行引擎：创建 session 后逐步提交任务，后台轮询等每步完成 |
| `stream_response` | 实时推送结果到所有 WebSocket 客户端 |
| `get_tunnel_status` | Wire 连接状态、客户端数、运行时间 |
| `learn_workflow` | 从口头描述或历史 session 学习工作流，生成 YAML 模板 |
| `list_templates` | 列出所有可用的工作流模板 |
| `execute_workflow` | 执行工作流模板：创建任务 session，逐步下发指令，自适应调整 |
| `continue_workflow` | 对暂停的工作流执行决策（重试/跳过/终止/手动覆盖） |
| `watch_session` | 启动 WS 后台监听，主动等待任务 session 完成 |
| `get_watch_result` | 获取后台监听结果（非阻塞） |
| `continue_watch` | 拿结果+自动发下一步指令+启动新监听，形成自动化循环 |

## REST API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/` | GET | Web 调试控制台 |
| `/workflow-console.html` | GET | 工作流实时监管页面 |
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
├── index.ts                 # 入口：创建 TunnelServices，启动 HTTP+MCP
├── types.ts                 # TunnelServices 依赖注入接口
├── mcp-server.ts            # MCP stdio 服务器（注册 17 个工具）
├── http-server.ts           # Express + WebSocket 装配入口
├── wire-client.ts           # Kimi Server REST + WS 推送客户端
├── message-queue.ts         # WebSocket pub/sub 广播
├── session-store.ts         # 文件系统扫描 + 路径解析
├── session-log-reader.ts    # wire.jsonl 日志解析 + IO 提取 + 状态轮询
├── session-orchestrator.ts  # 多轮任务编排引擎
├── workflow-template.ts     # 模板类型定义 + YAML 解析 + Zod 校验
├── workflow-store.ts        # 模板持久化（CRUD）
├── workflow-engine.ts       # 自适应工作流引擎
├── session-watcher.ts        # WS 后台监听器
├── tools/
│   ├── execute-prompt.ts    # 发送 prompt 并等待完整回复
│   ├── chat-with-session.ts # 全自动多轮编排
│   ├── create-session.ts    # 通过 REST API 创建新 session
│   ├── stream-response.ts   # 实时推送到 WebSocket 客户端
│   ├── list-sessions.ts     # 列出所有 session
│   ├── get-session-info.ts  # 查看 session 详情
│   ├── read-session-log.ts  # 读取对话日志
│   ├── list-io-records.ts   # 快速查看输入输出记录
│   ├── poll-session.ts      # 结构化轮询 session 状态
│   ├── run-flow.ts           # 分步流程执行引擎
│   ├── learn-workflow.ts    # 从描述或历史 session 学习模板
│   ├── execute-workflow.ts  # 执行工作流模板
│   ├── list-workflow-templates.ts # 列出可用模板
│   ├── continue-workflow.ts # 暂停工作流的决策处理
│   ├── session-watch.ts     # 后台监听工具 (watch/get/continue)
│   └── get-tunnel-status.ts # Wire 连接状态、客户端数、运行时间
└── public/
    ├── console.html          # Web 调试控制台
    └── workflow-console.html # 工作流实时监管页面
```

## License

MIT
