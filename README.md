<!--
修改记录:
  2026-07-05 | kimi-code (md-update) | 更新项目结构树：新增 routes/ types.ts kimi-api-transport.ts content-processor.ts ws-handler.ts session-store.ts session-log-reader.ts
  2026-07-05 | kimi-code (md-update) | 修正 /api/send 描述：已改为直接调用 WireClient 而非队列
  2026-07-05 | kimi-code (refactor)   | 架构深化：删除 v1 死代码，引入 TunnelServices DI，拆分 WireClient/HTTP/Session 模块
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
│   ├─ WireClient (REST)        │
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
| `execute_prompt` | 发送 prompt 并等待完整回复，默认排除思考链 |
| `chat_with_session` | 全自动多轮编排，直到任务完成或达到最大轮次 |
| `stream_response` | 实时推送结果到所有 WebSocket 客户端 |
| `list_sessions` | 列出所有 session |
| `get_session_info` | 查看 session 详情 |
| `read_session_log` | 读取对话日志，检测 turn 完成状态 |
| `get_tunnel_status` | Wire 连接状态、客户端数、运行时间 |

## REST API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/` | GET | Web 调试控制台 |
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
├── mcp-server.ts            # MCP stdio 服务器（注册 7 个工具）
├── http-server.ts           # Express + WebSocket 装配入口
├── wire-client.ts           # Prompt 执行器（使用 Transport + ContentProcessor）
├── kimi-api-transport.ts    # 纯 HTTP 传输适配器（GET/POST + auth）
├── content-processor.ts     # 纯函数：文本提取、思考过滤
├── message-queue.ts         # WebSocket 客户端管理 + 响应广播
├── ws-handler.ts            # WebSocket 连接处理器
├── session-manager.ts       # Session 管理薄委托层
├── session-store.ts         # 文件系统扫描 + 缓存
├── session-log-reader.ts    # wire.jsonl 日志解析器
├── session-orchestrator.ts  # 多轮任务编排引擎
├── routes/
│   ├── console.ts           # GET /   Web 调试控制台
│   ├── execute.ts           # POST /api/execute
│   ├── send.ts              # POST /api/send
│   └── status.ts            # GET /api/status
├── tools/
│   ├── execute-prompt.ts    # 发送 prompt 并等待完整回复
│   ├── chat-with-session.ts # 全自动多轮编排
│   ├── stream-response.ts   # 实时推送到 WebSocket 客户端
│   ├── list-sessions.ts     # 列出所有 session
│   ├── get-session-info.ts  # 查看 session 详情
│   ├── read-session-log.ts  # 读取对话日志
│   └── get-tunnel-status.ts # Wire 连接状态、客户端数、运行时间
└── public/
    └── console.html          # Web 调试控制台
```

## License

MIT
