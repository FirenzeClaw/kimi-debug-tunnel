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
| `/api/send` | POST | 发送消息到队列（兼容模式） |
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
├── index.ts              # 入口
├── mcp-server.ts         # MCP stdio 服务器
├── http-server.ts        # Express + WebSocket
├── wire-client.ts        # Kimi Server REST API 客户端
├── message-queue.ts      # 消息队列
├── session-manager.ts    # Session 扫描与管理
├── session-orchestrator.ts # 多轮编排引擎
├── tools/
│   ├── execute-prompt.ts
│   ├── chat-with-session.ts
│   ├── stream-response.ts
│   ├── list-sessions.ts
│   ├── get-session-info.ts
│   ├── read-session-log.ts
│   └── get-tunnel-status.ts
└── public/
    └── console.html       # Web 调试控制台
```

## License

MIT
